import { loadConfig } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { createApp } from './app.js';
import { processRequiredRefunds, sweepExpiredBookings } from './services/bookings.js';

const config = loadConfig();
const app = createApp();
const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info({ port: config.PORT }, 'CinemaSeat API listening');
});

let sweepRunning = false;
const sweeper = setInterval(async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await sweepExpiredBookings();
    await processRequiredRefunds();
  } catch (error) {
    logger.error({ error }, 'Hold expiry sweep failed');
  } finally {
    sweepRunning = false;
  }
}, config.HOLD_SWEEP_INTERVAL_MS);
sweeper.unref();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  clearInterval(sweeper);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

