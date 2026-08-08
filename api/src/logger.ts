import pino from 'pino';
import { loadConfig } from './config.js';

export const logger = pino({ level: loadConfig().LOG_LEVEL });

