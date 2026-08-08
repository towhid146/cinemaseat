import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signatureMatches } from '../../src/routes/webhook.js';

describe('gateway webhook signature', () => {
  it('accepts the HMAC of the exact raw bytes', () => {
    const body = Buffer.from('{"booking_ref":"bk_1","amount":450}');
    const signature = createHmac('sha256', 'z2p-2026-secret').update(body).digest('hex');
    expect(signatureMatches(body, signature)).toBe(true);
    expect(signatureMatches(body, `sha256=${signature}`)).toBe(true);
  });

  it('rejects missing, changed, and malformed signatures', () => {
    const body = Buffer.from('{"amount":450}');
    const signature = createHmac('sha256', 'z2p-2026-secret').update(body).digest('hex');
    expect(signatureMatches(body, undefined)).toBe(false);
    expect(signatureMatches(Buffer.from('{"amount":451}'), signature)).toBe(false);
    expect(signatureMatches(body, 'not-a-signature')).toBe(false);
  });
});

