import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('configuration', () => {
  it('reads HOLD_TTL_SECONDS from the environment', () => {
    expect(loadConfig({ HOLD_TTL_SECONDS: '7' }).HOLD_TTL_SECONDS).toBe(7);
  });

  it('rejects a non-positive hold TTL', () => {
    expect(() => loadConfig({ HOLD_TTL_SECONDS: '0' })).toThrow();
  });

  it('uses a container-reachable callback URL by default', () => {
    expect(loadConfig({}).GATEWAY_CALLBACK_URL).toBe('http://api:3000/webhooks/payment');
    expect(loadConfig({}).GATEWAY_OTP_CALLBACK_URL).toBe('http://api:3000/webhooks/otp');
  });

  it('keeps Redis optional with bounded cache and lock defaults', () => {
    const config = loadConfig({});
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.REDIS_CACHE_TTL_SECONDS).toBe(30);
    expect(config.REDIS_LOCK_TTL_MS).toBe(3000);
  });
});
