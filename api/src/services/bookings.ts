import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadConfig } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError } from '../errors.js';
import * as gateway from './gateway.js';
import type { MockHeaders } from '../types.js';

function bookingRef(): string {
  return `bk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function ticketRef(ref: string): string {
  return `TKT-${ref.slice(3).toUpperCase()}`;
}

async function expireWhere(client: PoolClient, whereSql: string, values: unknown[]) {
  return client.query(
    `WITH expired AS (
       UPDATE bookings
          SET status = 'EXPIRED', updated_at = now()
        WHERE status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING')
          AND expires_at <= now() AND ${whereSql}
        RETURNING id
     )
     UPDATE payments p
        SET refund_required = true, updated_at = now()
       FROM expired e
      WHERE p.booking_id = e.id AND p.status = 'SUCCEEDED'
      RETURNING p.gateway_payment_id AS "paymentId"`,
    values
  );
}

export async function sweepExpiredBookings(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query<{ id: string }>(
      `UPDATE bookings
          SET status = 'EXPIRED', updated_at = now()
        WHERE status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING')
          AND expires_at <= now()
        RETURNING id`
    );
    await client.query(
      `UPDATE payments p SET refund_required = true, updated_at = now()
        FROM unnest($1::uuid[]) AS e(id)
       WHERE p.booking_id = e.id AND p.status = 'SUCCEEDED'`,
      [expired.rows.map((row) => row.id)]
    );
    await client.query('COMMIT');
    return expired.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function processRequiredRefunds(): Promise<number> {
  const claimed = await pool.query<{ id: string; paymentId: string }>(
    `UPDATE payments
        SET status = 'REFUND_PENDING', refund_required = false, updated_at = now()
      WHERE id IN (
        SELECT id FROM payments
         WHERE refund_required = true AND gateway_payment_id IS NOT NULL AND status = 'SUCCEEDED'
         ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, gateway_payment_id AS "paymentId"`
  );
  await Promise.all(claimed.rows.map(async (payment) => {
    try {
      await gateway.refund(payment.paymentId);
    } catch {
      await pool.query(
        `UPDATE payments SET status = 'SUCCEEDED', refund_required = true, updated_at = now()
          WHERE id = $1 AND status = 'REFUND_PENDING'`,
        [payment.id]
      );
    }
  }));
  return claimed.rowCount ?? 0;
}

export async function createHold(showtimeId: number, seatLabel: string, userId: string) {
  const client = await pool.connect();
  const id = randomUUID();
  const ref = bookingRef();
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'showtime_id = $1 AND seat_label = $2', [showtimeId, seatLabel]);
    const result = await client.query<{
      bookingRef: string; status: string; seatLabel: string; showtimeId: number; expiresAt: Date;
    }>(
      `INSERT INTO bookings (
         id, booking_ref, user_id, showtime_id, seat_label, status, expires_at
       )
       SELECT $1, $2, $3, s.showtime_id, s.seat_label, 'HELD',
              now() + ($6 * interval '1 second')
         FROM seats s
        WHERE s.showtime_id = $4 AND s.seat_label = $5
       ON CONFLICT DO NOTHING
       RETURNING booking_ref AS "bookingRef", status, seat_label AS "seatLabel",
                 showtime_id AS "showtimeId", expires_at AS "expiresAt"`,
      [id, ref, userId, showtimeId, seatLabel, loadConfig().HOLD_TTL_SECONDS]
    );
    if (result.rowCount === 0) {
      const exists = await client.query('SELECT 1 FROM seats WHERE showtime_id = $1 AND seat_label = $2', [showtimeId, seatLabel]);
      await client.query('ROLLBACK');
      if (exists.rowCount === 0) throw new AppError(404, 'SEAT_NOT_FOUND', 'Seat not found');
      throw new AppError(409, 'SEAT_UNAVAILABLE', 'Seat unavailable');
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function getSeatMap(showtimeId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'showtime_id = $1', [showtimeId]);
    const showtime = await client.query('SELECT 1 FROM showtimes WHERE id = $1', [showtimeId]);
    if (showtime.rowCount === 0) throw new AppError(404, 'SHOWTIME_NOT_FOUND', 'Showtime not found');
    const seats = await client.query(
      `SELECT s.seat_label AS "seatLabel", s.row_number AS "rowNumber",
              s.seat_number AS "seatNumber", s.price, s.currency,
              CASE WHEN b.status = 'CONFIRMED' THEN 'CONFIRMED'
                   WHEN b.id IS NOT NULL THEN 'HELD' ELSE 'AVAILABLE' END AS status,
              CASE WHEN b.status <> 'CONFIRMED' THEN b.expires_at END AS "expiresAt"
         FROM seats s
         LEFT JOIN bookings b
           ON b.showtime_id = s.showtime_id AND b.seat_label = s.seat_label
          AND b.status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING', 'CONFIRMED')
        WHERE s.showtime_id = $1
        ORDER BY s.row_number, s.seat_number`,
      [showtimeId]
    );
    await client.query('COMMIT');
    return { showtimeId, seats: seats.rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getBooking(ref: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'booking_ref = $1', [ref]);
    const result = await client.query(
      `SELECT b.booking_ref AS "bookingRef", b.user_id AS "userId",
              b.showtime_id AS "showtimeId", b.seat_label AS "seatLabel",
              b.status, b.payment_status AS "paymentStatus", b.otp_status AS "otpStatus",
              b.expires_at AS "expiresAt", b.ticket_ref AS "ticketRef",
              b.confirmed_at AS "confirmedAt", s.price, s.currency
         FROM bookings b JOIN seats s
           ON s.showtime_id = b.showtime_id AND s.seat_label = b.seat_label
        WHERE b.booking_ref = $1`,
      [ref]
    );
    if (result.rowCount === 0) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initiatePayment(ref: string, mock: MockHeaders) {
  const client = await pool.connect();
  let payment: { amount: number; currency: string; idempotencyKey: string };
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'booking_ref = $1', [ref]);
    const booking = await client.query<{
      id: string; status: string; amount: number; currency: string; paymentStatus: string;
    }>(
      `SELECT b.id, b.status, s.price AS amount, s.currency,
              b.payment_status AS "paymentStatus"
         FROM bookings b JOIN seats s
           ON s.showtime_id = b.showtime_id AND s.seat_label = b.seat_label
        WHERE b.booking_ref = $1 FOR UPDATE OF b`,
      [ref]
    );
    if (booking.rowCount === 0) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const row = booking.rows[0];
    if (row.status === 'EXPIRED') throw new AppError(410, 'HOLD_EXPIRED', 'Hold expired');
    if (row.status === 'CONFIRMED') {
      await client.query('COMMIT');
      return { bookingRef: ref, status: 'CONFIRMED', gatewayAccepted: true };
    }
    if (['PAYMENT_FAILED', 'CANCELLED'].includes(row.status)) {
      throw new AppError(409, 'BOOKING_NOT_PAYABLE', 'Booking cannot be paid');
    }
    const key = `charge:${ref}`;
    const paymentResult = await client.query<{ amount: number; currency: string; idempotencyKey: string }>(
      `INSERT INTO payments (
         id, booking_id, booking_ref, idempotency_key, status, amount, currency
       ) VALUES ($1, $2, $3, $4, 'INITIATING', $5, $6)
       ON CONFLICT (booking_id) DO UPDATE SET updated_at = now()
       RETURNING amount, currency, idempotency_key AS "idempotencyKey"`,
      [randomUUID(), row.id, ref, key, row.amount, row.currency]
    );
    payment = paymentResult.rows[0];
    await client.query(
      `UPDATE bookings
          SET status = CASE WHEN status = 'HELD' THEN 'PAYMENT_PENDING' ELSE status END,
              payment_status = CASE WHEN payment_status = 'NOT_STARTED' THEN 'INITIATING' ELSE payment_status END,
              updated_at = now()
        WHERE id = $1`,
      [row.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const charged = await gateway.charge({
      amount: payment.amount,
      currency: payment.currency,
      bookingRef: ref,
      idempotencyKey: payment.idempotencyKey,
      mock
    });
    await pool.query(
      `UPDATE payments
          SET gateway_payment_id = COALESCE(gateway_payment_id, $2),
              status = CASE WHEN status = 'INITIATING' THEN 'PENDING' ELSE status END,
              updated_at = now()
        WHERE booking_ref = $1`,
      [ref, charged.payment_id]
    );
    await pool.query(
      `UPDATE bookings SET payment_status = 'PENDING', updated_at = now()
        WHERE booking_ref = $1 AND payment_status = 'INITIATING'`,
      [ref]
    );
    return { bookingRef: ref, status: 'PAYMENT_PENDING', paymentId: charged.payment_id, gatewayAccepted: true };
  } catch (error) {
    return {
      bookingRef: ref,
      status: 'PAYMENT_PENDING',
      gatewayAccepted: false,
      message: 'Gateway acknowledgement not received; retry safely with the same booking reference'
    };
  }
}

export async function sendBookingOtp(ref: string, phone: string, mock: Pick<MockHeaders, 'mode'> = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'booking_ref = $1', [ref]);
    const booking = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM bookings WHERE booking_ref = $1 FOR UPDATE', [ref]
    );
    if (booking.rowCount === 0) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    if (booking.rows[0].status === 'EXPIRED') throw new AppError(410, 'HOLD_EXPIRED', 'Hold expired');
    if (['PAYMENT_FAILED', 'CANCELLED'].includes(booking.rows[0].status)) {
      throw new AppError(409, 'BOOKING_INACTIVE', 'Booking is inactive');
    }
    await client.query(
      `INSERT INTO otp_verifications (id, booking_id, ref, phone, status)
       VALUES ($1, $2, $3, $4, 'PENDING')`,
      [randomUUID(), booking.rows[0].id, ref, phone]
    );
    await client.query(
      `UPDATE bookings SET otp_status = 'PENDING', updated_at = now()
        WHERE id = $1 AND otp_status <> 'VERIFIED'`,
      [booking.rows[0].id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    await gateway.sendOtp(phone, ref, mock);
    return { bookingRef: ref, status: 'OTP_PENDING', gatewayAccepted: true };
  } catch {
    return { bookingRef: ref, status: 'OTP_PENDING', gatewayAccepted: false };
  }
}

export async function recordOtpDelivery(ref: string): Promise<boolean> {
  const delivered = await pool.query(
    `UPDATE otp_verifications
        SET updated_at = now()
      WHERE id = (
        SELECT id FROM otp_verifications
         WHERE ref = $1
         ORDER BY created_at DESC
         LIMIT 1
      )
      RETURNING id`,
    [ref]
  );
  return delivered.rowCount === 1;
}

export async function verifyBookingOtp(ref: string, code: string) {
  const current = await getBooking(ref);
  if (current.status === 'EXPIRED') throw new AppError(410, 'HOLD_EXPIRED', 'Hold expired');
  try {
    const result = await gateway.verifyOtp(ref, code);
    if (!result.verified) throw new gateway.GatewayError('Wrong or expired OTP', 400);
  } catch (error) {
    const status = error instanceof gateway.GatewayError ? error.status : undefined;
    const locked = status === 429;
    await pool.query(
      `WITH latest AS (
         SELECT id FROM otp_verifications WHERE ref = $1 ORDER BY created_at DESC LIMIT 1
       )
       UPDATE otp_verifications
          SET attempts = attempts + 1, status = CASE WHEN $2 THEN 'LOCKED' ELSE 'FAILED' END,
              updated_at = now()
        WHERE id IN (SELECT id FROM latest)`,
      [ref, locked]
    );
    await pool.query(
      `UPDATE bookings SET otp_status = CASE WHEN $2 THEN 'LOCKED' ELSE 'FAILED' END, updated_at = now()
        WHERE booking_ref = $1`,
      [ref, locked]
    );
    throw new AppError(locked ? 429 : 400, locked ? 'OTP_LOCKED' : 'OTP_INVALID', locked ? 'Too many OTP attempts' : 'Wrong or expired OTP');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireWhere(client, 'booking_ref = $1', [ref]);
    const booking = await client.query<{ id: string; status: string; paymentStatus: string }>(
      `SELECT id, status, payment_status AS "paymentStatus"
         FROM bookings WHERE booking_ref = $1 FOR UPDATE`,
      [ref]
    );
    if (booking.rows[0].status === 'EXPIRED') throw new AppError(410, 'HOLD_EXPIRED', 'Hold expired');
    await client.query(
      `UPDATE otp_verifications SET status = 'VERIFIED', updated_at = now()
        WHERE id = (SELECT id FROM otp_verifications WHERE ref = $1 ORDER BY created_at DESC LIMIT 1)`,
      [ref]
    );
    const nextStatus = booking.rows[0].paymentStatus === 'SUCCEEDED' ? 'CONFIRMED' : booking.rows[0].status;
    await client.query(
      `UPDATE bookings
          SET otp_status = 'VERIFIED', status = $2,
              ticket_ref = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(ticket_ref, $3) ELSE ticket_ref END,
              confirmed_at = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
              updated_at = now()
        WHERE id = $1`,
      [booking.rows[0].id, nextStatus, ticketRef(ref)]
    );
    await client.query('COMMIT');
    return { bookingRef: ref, verified: true, status: nextStatus };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
