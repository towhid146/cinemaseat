export const ACTIVE_BOOKING_STATUSES = ['HELD', 'AWAITING_OTP', 'PAYMENT_PENDING', 'CONFIRMED'] as const;
export const EXPIRABLE_BOOKING_STATUSES = ['HELD', 'AWAITING_OTP', 'PAYMENT_PENDING'] as const;

export type MockHeaders = {
  force?: string;
  mode?: string;
};

export type GatewayPaymentEvent = {
  event_id: string;
  payment_id: string;
  booking_ref: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | string;
  amount: number;
  currency: string;
  timestamp: string;
};

