import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, 'migrations', '001_initial.sql'), 'utf8');
  await pool.query(sql);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}

