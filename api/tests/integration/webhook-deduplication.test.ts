import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import { createHold } from '../../src/services/bookings.js';
import { processPaymentEvent } from '../../src/services/webhooks.js';

const databaseAvailable = Boolean(process.env.DATABASE_URL);

describe.runIf(databaseAvailable)('payment webhook transactionality', () => {
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
    await pool.end();
  });

  it('matches an early callback by booking_ref and processes one event only once', async () => {
    const hold = await createHold(showtimeId, 'A3', 'race-user');
    const booking = await pool.query<{ id: string }>('SELECT id FROM bookings WHERE booking_ref = $1', [hold.bookingRef]);
    await pool.query("UPDATE bookings SET otp_status = 'VERIFIED' WHERE id = $1", [booking.rows[0].id]);
    await pool.query(
      `INSERT INTO payments (id, booking_id, booking_ref, idempotency_key, status, amount, currency)
       VALUES ($1, $2, $3, $4, 'INITIATING', 450, 'BDT')`,
      [randomUUID(), booking.rows[0].id, hold.bookingRef, `charge:${hold.bookingRef}`]
    );
    const event = {
      event_id: 'evt_dedupe_1',
      payment_id: 'pay_raced_1',
      booking_ref: hold.bookingRef,
      status: 'SUCCEEDED',
      amount: 450,
      currency: 'BDT',
      timestamp: new Date().toISOString()
    };

    expect(await processPaymentEvent(event)).toEqual({ duplicate: false, processed: true });
    expect(await processPaymentEvent(event)).toEqual({ duplicate: true, processed: false });

    const state = await pool.query(
      `SELECT b.status, b.ticket_ref, p.status AS payment_status, p.gateway_payment_id
         FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1`,
      [booking.rows[0].id]
    );
    expect(state.rows[0].status).toBe('CONFIRMED');
    expect(state.rows[0].ticket_ref).toMatch(/^TKT-/);
    expect(state.rows[0].payment_status).toBe('SUCCEEDED');
    expect(state.rows[0].gateway_payment_id).toBe('pay_raced_1');
    expect((await pool.query("SELECT count(*)::int AS count FROM webhook_events WHERE event_id = 'evt_dedupe_1'")).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count, sum(amount)::int AS revenue FROM payments')).rows[0]).toEqual({ count: 1, revenue: 450 });

    await pool.query("UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1", [booking.rows[0].id]);
    expect(await processPaymentEvent({ ...event, event_id: 'evt_late_duplicate' })).toEqual({ duplicate: false, processed: true });
    const stable = await pool.query(
      'SELECT b.status, p.refund_required FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1',
      [booking.rows[0].id]
    );
    expect(stable.rows[0]).toEqual({ status: 'CONFIRMED', refund_required: false });
  });
});
