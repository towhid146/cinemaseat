import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('payment webhook HTTP contract', () => {
  it('returns 2xx for an invalid signature so the gateway does not retry chaotically', async () => {
    const response = await request(createApp())
      .post('/webhooks/payment')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event_id: 'evt_invalid' }));

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(false);
  });

  it('returns 2xx for an OTP callback it cannot recognize', async () => {
    const response = await request(createApp())
      .post('/webhooks/otp')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ unexpected: true }));

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(false);
  });
});
