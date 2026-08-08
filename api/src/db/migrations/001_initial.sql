CREATE TABLE IF NOT EXISTS movies (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  rating TEXT NOT NULL,
  poster_url TEXT
);

CREATE TABLE IF NOT EXISTS theatres (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS showtimes (
  id SERIAL PRIMARY KEY,
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  theatre_id INTEGER NOT NULL REFERENCES theatres(id),
  auditorium TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  showtime_id INTEGER NOT NULL REFERENCES showtimes(id) ON DELETE CASCADE,
  seat_label TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  seat_number INTEGER NOT NULL CHECK (seat_number > 0),
  price INTEGER NOT NULL CHECK (price > 0),
  currency CHAR(3) NOT NULL DEFAULT 'BDT',
  PRIMARY KEY (showtime_id, seat_label),
  UNIQUE (showtime_id, row_number, seat_number)
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY,
  booking_ref TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  showtime_id INTEGER NOT NULL,
  seat_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'HELD', 'AWAITING_OTP', 'PAYMENT_PENDING', 'CONFIRMED',
    'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'
  )),
  payment_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (payment_status IN (
    'NOT_STARTED', 'INITIATING', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'
  )),
  otp_status TEXT NOT NULL DEFAULT 'NOT_SENT' CHECK (otp_status IN (
    'NOT_SENT', 'PENDING', 'VERIFIED', 'FAILED', 'LOCKED'
  )),
  expires_at TIMESTAMPTZ NOT NULL,
  ticket_ref TEXT UNIQUE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (showtime_id, seat_label) REFERENCES seats(showtime_id, seat_label)
);

-- The database is the lock: exactly one active lifecycle may own a seat.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_seat
  ON bookings (showtime_id, seat_label)
  WHERE status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING', 'CONFIRMED');
CREATE INDEX IF NOT EXISTS bookings_expiry_idx
  ON bookings (expires_at)
  WHERE status IN ('HELD', 'AWAITING_OTP', 'PAYMENT_PENDING');

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  booking_ref TEXT NOT NULL UNIQUE REFERENCES bookings(booking_ref) ON DELETE CASCADE,
  gateway_payment_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'INITIATING', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'
  )),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  refund_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  gateway_event TEXT,
  booking_ref TEXT,
  payment_id TEXT,
  status TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'FAILED', 'LOCKED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_booking_idx ON otp_verifications (booking_id, created_at DESC);

