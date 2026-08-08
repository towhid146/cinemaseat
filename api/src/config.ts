import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://cinemaseat:cinemaseat@localhost:5432/cinemaseat'),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  HOLD_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  GATEWAY_URL: z.string().url().default('http://localhost:9000'),
  GATEWAY_CALLBACK_URL: z.string().url().default('http://api:3000/webhooks/payment'),
  GATEWAY_SECRET: z.string().min(1).default('z2p-2026-secret'),
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.string().default('info')
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

