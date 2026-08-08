import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { paymentWebhook } from './routes/webhook.js';
import * as bookings from './services/bookings.js';
import * as catalog from './services/catalog.js';

const holdBody = z.object({
  seatLabel: z.string().trim().min(1).max(10).transform((value) => value.toUpperCase()),
  userId: z.string().trim().min(1).max(100)
});
const phoneBody = z.object({ phone: z.string().trim().min(6).max(30) });
const otpBody = z.object({ code: z.string().trim().min(1).max(20) });

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new AppError(400, 'INVALID_ID', 'Expected a positive integer id');
  return parsed;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id']?.toString() ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    }
  }));

  // This route must see the byte-exact body before the global JSON parser.
  app.post('/webhooks/payment', express.raw({ type: 'application/json', limit: '100kb' }), paymentWebhook);
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  });
  app.get('/ready', async (_req, res) => {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  });

  app.get('/api/movies', async (_req, res) => res.json({ movies: await catalog.listMovies() }));
  app.get('/api/theatres', async (_req, res) => res.json({ theatres: await catalog.listTheatres() }));
  app.get('/api/showtimes', async (_req, res) => res.json({ showtimes: await catalog.listShowtimes() }));

  app.get('/api/showtimes/:showtimeId/seats', async (req, res) => {
    res.json(await bookings.getSeatMap(positiveInt(req.params.showtimeId)));
  });
  app.post('/api/showtimes/:showtimeId/holds', async (req, res) => {
    const body = holdBody.parse(req.body);
    const hold = await bookings.createHold(positiveInt(req.params.showtimeId), body.seatLabel, body.userId);
    res.status(201).json(hold);
  });
  app.get('/api/bookings/:bookingRef', async (req, res) => {
    res.json(await bookings.getBooking(req.params.bookingRef));
  });
  app.post('/api/bookings/:bookingRef/pay', async (req, res) => {
    const payment = await bookings.initiatePayment(req.params.bookingRef, {
      force: req.header('x-mock-force') ?? undefined,
      mode: req.header('x-mock-mode') ?? undefined
    });
    res.status(202).json(payment);
  });
  app.post('/api/bookings/:bookingRef/otp/send', async (req, res) => {
    const body = phoneBody.parse(req.body);
    const otp = await bookings.sendBookingOtp(req.params.bookingRef, body.phone);
    res.status(202).json(otp);
  });
  app.post('/api/bookings/:bookingRef/otp/verify', async (req, res) => {
    const body = otpBody.parse(req.body);
    res.json(await bookings.verifyBookingOtp(req.params.bookingRef, body.code));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    req.log.error({ error }, 'Unhandled request error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  return app;
}
