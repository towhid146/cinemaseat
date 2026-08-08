import { describe, expect, it, vi } from 'vitest';
import { acquireSeatLock, cachedJson } from '../../src/services/redis.js';

function fakeRedis(overrides: Partial<{
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    get: overrides.get ?? vi.fn().mockResolvedValue(null),
    set: overrides.set ?? vi.fn().mockResolvedValue('OK'),
    eval: overrides.eval ?? vi.fn().mockResolvedValue(1)
  };
}

describe('optional Redis acceleration', () => {
  it('caches static data and serves a cache hit without calling PostgreSQL again', async () => {
    const client = fakeRedis();
    const loader = vi.fn().mockResolvedValue([{ id: 1, title: 'Interstellar' }]);

    const loaded = await cachedJson('catalog', 30, loader, client);
    expect(loaded).toEqual([{ id: 1, title: 'Interstellar' }]);
    expect(client.set).toHaveBeenCalledWith(
      'catalog',
      JSON.stringify(loaded),
      { expiration: { type: 'EX', value: 30 } }
    );

    client.get.mockResolvedValueOnce(JSON.stringify(loaded));
    const cacheHitLoader = vi.fn();
    expect(await cachedJson('catalog', 30, cacheHitLoader, client)).toEqual(loaded);
    expect(cacheHitLoader).not.toHaveBeenCalled();
  });

  it('uses a token-owned expiring lock and safely reports contention', async () => {
    const client = fakeRedis();
    const lease = await acquireSeatLock(1, 'A1', client);
    expect(lease.state).toBe('acquired');
    expect(client.set).toHaveBeenCalledWith(
      'cinemaseat:lock:seat:1:A1',
      expect.any(String),
      { expiration: { type: 'PX', value: 3000 }, condition: 'NX' }
    );
    if (lease.state === 'acquired') await lease.release();
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      { keys: ['cinemaseat:lock:seat:1:A1'], arguments: [expect.any(String)] }
    );

    const contender = await acquireSeatLock(1, 'A1', fakeRedis({
      set: vi.fn().mockResolvedValue(null)
    }));
    expect(contender).toEqual({ state: 'contended' });
  });

  it('fails open to PostgreSQL when Redis is disabled', async () => {
    const loader = vi.fn().mockResolvedValue(['database-result']);
    expect(await cachedJson('catalog', 30, loader, null)).toEqual(['database-result']);
    expect((await acquireSeatLock(1, 'A1', null)).state).toBe('unavailable');
  });

  it('fails open when Redis commands throw during an outage', async () => {
    const failingClient = fakeRedis({
      get: vi.fn().mockRejectedValue(new Error('socket closed')),
      set: vi.fn().mockRejectedValue(new Error('socket closed'))
    });
    const loader = vi.fn().mockResolvedValue(['postgres-result']);

    expect(await cachedJson('catalog', 30, loader, failingClient)).toEqual(['postgres-result']);
    expect((await acquireSeatLock(1, 'A1', failingClient)).state).toBe('unavailable');
  });
});
