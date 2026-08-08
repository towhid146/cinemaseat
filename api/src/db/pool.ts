import pg from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: loadConfig().DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

