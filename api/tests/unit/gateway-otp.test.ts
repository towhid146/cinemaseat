import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendOtp } from '../../src/services/gateway.js';

describe('gateway OTP integration contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the distinct container-reachable OTP callback and forwards deterministic mode', async () => {
    vi.stubEnv('GATEWAY_URL', 'http://gateway.test:9000');
    vi.stubEnv('GATEWAY_OTP_CALLBACK_URL', 'http://api:3000/webhooks/otp');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOtp('+8801700000000', 'bk_test', { mode: 'deterministic' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://gateway.test:9000/otp/send');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-mock-mode': 'deterministic'
    });
    expect(JSON.parse(String(init.body))).toEqual({
      phone: '+8801700000000',
      ref: 'bk_test',
      callback_url: 'http://api:3000/webhooks/otp'
    });
  });
});
