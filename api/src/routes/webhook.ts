import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { processPaymentEvent } from '../services/webhooks.js';
import type { GatewayPaymentEvent } from '../types.js';

export function signatureMatches(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', loadConfig().GATEWAY_SECRET).update(body).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function paymentWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!signatureMatches(rawBody, req.header('x-signature'))) {
    res.status(200).json({ accepted: false, reason: 'invalid_signature' });
    return;
  }

  try {
    const event = JSON.parse(rawBody.toString('utf8')) as GatewayPaymentEvent;
    if (!event.event_id || !event.booking_ref || !event.payment_id || !event.status) {
      res.status(200).json({ accepted: false, reason: 'invalid_payload' });
      return;
    }
    const result = await processPaymentEvent(event, req.header('x-gateway-event') ?? undefined);
    res.status(200).json({ accepted: true, ...result });
  } catch (error) {
    logger.error({ error }, 'Payment webhook could not be processed');
    res.status(200).json({ accepted: false, reason: 'processing_error' });
  }
}
