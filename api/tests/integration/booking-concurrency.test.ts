import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import { AppError } from '../../src/errors.js';
import { createHold, getSeatMap } from '../../src/services/bookings.js';
import { closeRedis } from '../../src/services/redis.js';

const databaseAvailable = Boolean(process.env.DATABASE_URL);

describe.runIf(databaseAvailable)('booking concurrency with PostgreSQL', () => {
  let showtimeId: number;

  beforeAll(async () => {
    await migrate();
    await seed();
    showtimeId = (await pool.query<{ id: number }>('SELECT id FROM showtimes ORDER BY id LIMIT 1')).rows[0].id;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE webhook_events, otp_verifications, payments, bookings CASCADE');
  });

  afterAll(async () => {
    closeRedis();
    await pool.end();
  });

  it('allows exactly one of 100 buyers to hold the same seat', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) => createHold(showtimeId, 'A1', `buyer-${index}`))
    );
    const successes = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(99);
    expect(failures.every((attempt) => attempt.reason instanceof AppError && attempt.reason.statusCode === 409)).toBe(true);

    const map = await getSeatMap(showtimeId);
    expect(map.seats.filter((seat) => seat.seatLabel === 'A1' && seat.status === 'HELD')).toHaveLength(1);
    const activeRows = await pool.query(
      `SELECT count(*)::int AS count FROM bookings
        WHERE showtime_id = $1 AND seat_label = 'A1'
          AND status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING', 'CONFIRMED')`,
      [showtimeId]
    );
    expect(activeRows.rows[0].count).toBe(1);
  });

  it('releases an expired hold for a different user', async () => {
    const previousTtl = process.env.HOLD_TTL_SECONDS;
    process.env.HOLD_TTL_SECONDS = '1';
    try {
      await createHold(showtimeId, 'A2', 'abandoning-user');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const replacement = await createHold(showtimeId, 'A2', 'second-user');
      expect(replacement.status).toBe('HELD');
      const rows = await pool.query(
        `SELECT user_id, status FROM bookings
          WHERE showtime_id = $1 AND seat_label = 'A2' ORDER BY created_at`,
        [showtimeId]
      );
      expect(rows.rows).toEqual([
        { user_id: 'abandoning-user', status: 'EXPIRED' },
        { user_id: 'second-user', status: 'HELD' }
      ]);
    } finally {
      if (previousTtl === undefined) delete process.env.HOLD_TTL_SECONDS;
      else process.env.HOLD_TTL_SECONDS = previousTtl;
    }
  });
});
