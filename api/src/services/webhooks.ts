import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { GatewayPaymentEvent } from '../types.js';

function ticketRef(ref: string): string {
  return `TKT-${ref.slice(3).toUpperCase()}`;
}

async function applySuccess(client: PoolClient, event: GatewayPaymentEvent, booking: {
  id: string;
  status: string;
  otpStatus: string;
  expiresAt: Date;
}) {
  if (booking.status === 'CONFIRMED') {
    await client.query(
      `UPDATE payments SET status = 'SUCCEEDED', refund_required = false,
              gateway_payment_id = COALESCE(gateway_payment_id, $2), updated_at = now()
        WHERE booking_id = $1`,
      [booking.id, event.payment_id]
    );
    return;
  }
  const expired = booking.expiresAt.getTime() <= Date.now();
  const terminal = ['EXPIRED', 'PAYMENT_FAILED', 'CANCELLED'].includes(booking.status);
  if (expired || terminal) {
    await client.query(
      `UPDATE bookings SET status = CASE WHEN status = 'CONFIRMED' THEN status ELSE 'EXPIRED' END,
              payment_status = 'SUCCEEDED', updated_at = now()
        WHERE id = $1`,
      [booking.id]
    );
    await client.query(
      `UPDATE payments SET status = 'SUCCEEDED', refund_required = true,
              gateway_payment_id = COALESCE(gateway_payment_id, $2), updated_at = now()
        WHERE booking_id = $1`,
      [booking.id, event.payment_id]
    );
    return;
  }

  const confirmed = booking.otpStatus === 'VERIFIED';
  await client.query(
    `UPDATE bookings
        SET payment_status = 'SUCCEEDED', status = $2,
            ticket_ref = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(ticket_ref, $3) ELSE ticket_ref END,
            confirmed_at = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
            updated_at = now()
      WHERE id = $1`,
    [booking.id, confirmed ? 'CONFIRMED' : 'AWAITING_OTP', ticketRef(event.booking_ref)]
  );
  await client.query(
    `UPDATE payments SET status = 'SUCCEEDED', refund_required = false,
            gateway_payment_id = COALESCE(gateway_payment_id, $2), updated_at = now()
      WHERE booking_id = $1`,
    [booking.id, event.payment_id]
  );
}

export async function processPaymentEvent(
  event: GatewayPaymentEvent,
  gatewayEventHeader?: string
): Promise<{ duplicate: boolean; processed: boolean; reason?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO webhook_events (
         event_id, gateway_event, booking_ref, payment_id, status, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.event_id, gatewayEventHeader ?? null, event.booking_ref, event.payment_id, event.status, JSON.stringify(event)]
    );
    if (inserted.rowCount === 0) {
      await client.query('COMMIT');
      return { duplicate: true, processed: false };
    }

    const bookingResult = await client.query<{
      id: string; status: string; otpStatus: string; expiresAt: Date; amount: number; currency: string;
    }>(
      `SELECT b.id, b.status, b.otp_status AS "otpStatus", b.expires_at AS "expiresAt",
              p.amount, p.currency
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id
        WHERE b.booking_ref = $1
        FOR UPDATE OF b`,
      [event.booking_ref]
    );
    if (bookingResult.rowCount === 0 || bookingResult.rows[0].amount == null) {
      await client.query('COMMIT');
      return { duplicate: false, processed: false, reason: 'booking_or_payment_not_known_yet' };
    }
    const booking = bookingResult.rows[0];
    if (Number(booking.amount) !== Number(event.amount) || booking.currency.trim() !== event.currency) {
      await client.query('COMMIT');
      return { duplicate: false, processed: false, reason: 'amount_or_currency_mismatch' };
    }

    if (event.status === 'SUCCEEDED') {
      await applySuccess(client, event, booking);
    } else if (event.status === 'FAILED') {
      if (booking.status !== 'CONFIRMED') {
        await client.query(
          `UPDATE bookings SET status = 'PAYMENT_FAILED', payment_status = 'FAILED', updated_at = now()
            WHERE id = $1`,
          [booking.id]
        );
        await client.query(
          `UPDATE payments SET status = 'FAILED',
                  gateway_payment_id = COALESCE(gateway_payment_id, $2), updated_at = now()
            WHERE booking_id = $1`,
          [booking.id, event.payment_id]
        );
      }
    } else if (event.status === 'REFUNDED') {
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', refund_required = false,
                gateway_payment_id = COALESCE(gateway_payment_id, $2), updated_at = now()
          WHERE booking_id = $1`,
        [booking.id, event.payment_id]
      );
      await client.query(
        `UPDATE bookings SET status = CASE WHEN status = 'EXPIRED' THEN 'EXPIRED' ELSE 'CANCELLED' END,
                payment_status = 'REFUNDED', updated_at = now()
          WHERE id = $1`,
        [booking.id]
      );
    } else {
      await client.query('COMMIT');
      return { duplicate: false, processed: false, reason: 'unknown_status' };
    }

    await client.query(
      `UPDATE webhook_events SET processed = true, processed_at = now() WHERE event_id = $1`,
      [event.event_id]
    );
    await client.query('COMMIT');
    return { duplicate: false, processed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
