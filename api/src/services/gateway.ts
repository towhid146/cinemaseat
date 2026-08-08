import { loadConfig } from '../config.js';
import type { MockHeaders } from '../types.js';

export class GatewayError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

async function gatewayFetch(path: string, init: RequestInit): Promise<Response> {
  const config = loadConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.GATEWAY_TIMEOUT_MS);
  try {
    return await fetch(`${config.GATEWAY_URL}${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gateway request failed';
    throw new GatewayError(message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function charge(input: {
  amount: number;
  currency: string;
  bookingRef: string;
  idempotencyKey: string;
  mock?: MockHeaders;
}): Promise<{ payment_id: string; status: string }> {
  const config = loadConfig();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': input.idempotencyKey
  };
  if (input.mock?.force) headers['x-mock-force'] = input.mock.force;
  if (input.mock?.mode) headers['x-mock-mode'] = input.mock.mode;

  const response = await gatewayFetch('/charge', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      booking_ref: input.bookingRef,
      callback_url: config.GATEWAY_CALLBACK_URL
    })
  });
  if (response.status !== 202) {
    throw new GatewayError(`Gateway charge returned ${response.status}`, response.status);
  }
  return (await response.json()) as { payment_id: string; status: string };
}

export async function refund(paymentId: string): Promise<void> {
  const response = await gatewayFetch('/refund', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payment_id: paymentId })
  });
  if (response.status !== 202) {
    throw new GatewayError(`Gateway refund returned ${response.status}`, response.status);
  }
}

export async function sendOtp(phone: string, ref: string, mock: Pick<MockHeaders, 'mode'> = {}): Promise<void> {
  const config = loadConfig();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (mock.mode) headers['x-mock-mode'] = mock.mode;
  const response = await gatewayFetch('/otp/send', {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone, ref, callback_url: config.GATEWAY_OTP_CALLBACK_URL })
  });
  if (response.status !== 202) {
    throw new GatewayError(`Gateway OTP send returned ${response.status}`, response.status);
  }
}

export async function verifyOtp(ref: string, code: string): Promise<{ verified: boolean }> {
  const response = await gatewayFetch('/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref, code })
  });
  if (response.status === 429) throw new GatewayError('Too many OTP attempts', 429);
  if (response.status === 400) throw new GatewayError('Wrong or expired OTP', 400);
  if (response.status !== 200) throw new GatewayError(`Gateway OTP verify returned ${response.status}`, response.status);
  return (await response.json()) as { verified: boolean };
}
