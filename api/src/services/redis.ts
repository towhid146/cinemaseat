import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

type RedisCommands = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: {
      expiration?: { type: 'EX' | 'PX'; value: number };
      condition?: 'NX' | 'XX';
    }
  ): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

type ActiveRedisClient = RedisCommands & {
  isReady: boolean;
  destroy(): void;
};

let activeClient: ActiveRedisClient | null = null;
let connectionAttempt: Promise<RedisCommands | null> | null = null;

async function redisClient(): Promise<RedisCommands | null> {
  const { REDIS_URL } = loadConfig();
  if (!REDIS_URL) return null;
  if (activeClient?.isReady) return activeClient as unknown as RedisCommands;
  if (connectionAttempt) return connectionAttempt;

  const candidate = createClient({
    url: REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 300, reconnectStrategy: false }
  });
  const usableCandidate = candidate as unknown as ActiveRedisClient;
  candidate.on('error', (error) => logger.warn({ error }, 'Redis client error; using PostgreSQL fallback'));
  candidate.on('end', () => {
    if (activeClient === usableCandidate) activeClient = null;
  });

  connectionAttempt = candidate.connect()
    .then(() => {
      activeClient = usableCandidate;
      return usableCandidate;
    })
    .catch((error) => {
      logger.warn({ error }, 'Redis unavailable; using PostgreSQL fallback');
      candidate.destroy();
      return null;
    })
    .finally(() => {
      connectionAttempt = null;
    });
  return connectionAttempt;
}

export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  overrideClient?: RedisCommands | null
): Promise<T> {
  const client = overrideClient === undefined ? await redisClient() : overrideClient;
  if (!client) return loader();

  try {
    const cached = await client.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch (error) {
    logger.warn({ error, key }, 'Redis cache read failed; loading from PostgreSQL');
  }

  const value = await loader();
  try {
    await client.set(key, JSON.stringify(value), {
      expiration: { type: 'EX', value: ttlSeconds }
    });
  } catch (error) {
    logger.warn({ error, key }, 'Redis cache write failed; returning PostgreSQL result');
  }
  return value;
}

export type SeatLockLease =
  | { state: 'acquired'; release: () => Promise<void> }
  | { state: 'contended' }
  | { state: 'unavailable' };

export async function acquireSeatLock(
  showtimeId: number,
  seatLabel: string,
  overrideClient?: RedisCommands | null
): Promise<SeatLockLease> {
  const client = overrideClient === undefined ? await redisClient() : overrideClient;
  if (!client) return { state: 'unavailable' };

  const key = `cinemaseat:lock:seat:${showtimeId}:${seatLabel}`;
  const token = randomUUID();
  try {
    const result = await client.set(key, token, {
      expiration: { type: 'PX', value: loadConfig().REDIS_LOCK_TTL_MS },
      condition: 'NX'
    });
    if (result !== 'OK') return { state: 'contended' };
  } catch (error) {
    logger.warn({ error, key }, 'Redis seat lock failed; using PostgreSQL constraint');
    return { state: 'unavailable' };
  }

  return {
    state: 'acquired',
    release: async () => {
      try {
        await client.eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then
             return redis.call('DEL', KEYS[1])
           end
           return 0`,
          { keys: [key], arguments: [token] }
        );
      } catch (error) {
        logger.warn({ error, key }, 'Redis seat lock release failed; lock will expire');
      }
    }
  };
}

export function closeRedis(): void {
  activeClient?.destroy();
  activeClient = null;
  connectionAttempt = null;
}
