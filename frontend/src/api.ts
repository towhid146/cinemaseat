import type { Booking, Hold, Movie, Seat, Showtime } from "./types";

const API_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

type JsonObject = Record<string, unknown>;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok) {
    const nestedError = body.error && typeof body.error === "object"
      ? (body.error as JsonObject)
      : undefined;
    const message =
      String(body.message || nestedError?.message || "") ||
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

function arrayFrom<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];

  const object = payload as JsonObject;
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as T[];
  }
  return [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeMovie(raw: JsonObject): Movie {
  return {
    id: String(raw.id ?? raw.movie_id ?? ""),
    title: stringValue(raw.title, stringValue(raw.name, "Untitled movie")),
    description: stringValue(raw.description, stringValue(raw.synopsis)) || undefined,
    durationMinutes:
      typeof raw.durationMinutes === "number"
        ? raw.durationMinutes
        : typeof raw.duration_minutes === "number"
          ? raw.duration_minutes
          : undefined,
    posterUrl:
      stringValue(raw.posterUrl, stringValue(raw.poster_url)) || undefined,
  };
}

function normalizeShowtime(raw: JsonObject): Showtime {
  const theatre =
    raw.theatre && typeof raw.theatre === "object"
      ? (raw.theatre as JsonObject)
      : undefined;
  const movie =
    raw.movie && typeof raw.movie === "object"
      ? (raw.movie as JsonObject)
      : undefined;

  return {
    id: String(raw.id ?? raw.showtime_id ?? ""),
    movieId: String(raw.movieId ?? raw.movie_id ?? movie?.id ?? "") || undefined,
    movieTitle:
      stringValue(raw.movieTitle, stringValue(raw.movie_title, stringValue(movie?.title))) ||
      undefined,
    theatreId:
      String(raw.theatreId ?? raw.theatre_id ?? theatre?.id ?? "") || undefined,
    theatreName: stringValue(
      raw.theatreName,
      stringValue(raw.theatre_name, stringValue(theatre?.name, "Cinema")),
    ),
    startsAt: stringValue(
      raw.startsAt,
      stringValue(raw.starts_at, stringValue(raw.start_time)),
    ),
    price: typeof raw.price === "number" ? raw.price : undefined,
    currency: stringValue(raw.currency, "BDT"),
  };
}

function normalizeSeat(raw: JsonObject): Seat {
  const rawStatus = stringValue(raw.status, "AVAILABLE").toUpperCase();
  const status =
    rawStatus === "SOLD" || rawStatus === "CONFIRMED"
      ? "CONFIRMED"
      : rawStatus === "BOOKED"
        ? "BOOKED"
        : rawStatus === "HELD"
          ? "HELD"
          : "AVAILABLE";

  return {
    label: stringValue(raw.label, stringValue(raw.seatLabel, stringValue(raw.seat_label))),
    status,
    price: typeof raw.price === "number" ? raw.price : undefined,
  };
}

function normalizeHold(payload: unknown): Hold {
  const wrapper = payload as JsonObject;
  const raw =
    wrapper.hold && typeof wrapper.hold === "object"
      ? (wrapper.hold as JsonObject)
      : wrapper;
  const booking =
    wrapper.booking && typeof wrapper.booking === "object"
      ? (wrapper.booking as JsonObject)
      : undefined;

  return {
    id: String(raw.id ?? raw.holdId ?? raw.hold_id ?? ""),
    bookingRef: String(
      raw.bookingRef ??
        raw.booking_ref ??
        booking?.bookingRef ??
        booking?.booking_ref ??
        "",
    ),
    showtimeId: String(raw.showtimeId ?? raw.showtime_id ?? ""),
    seatLabel: stringValue(raw.seatLabel, stringValue(raw.seat_label)),
    expiresAt: stringValue(raw.expiresAt, stringValue(raw.expires_at)),
    status: stringValue(raw.status, "HELD"),
  };
}

function normalizeBooking(payload: unknown): Booking {
  const wrapper = payload as JsonObject;
  const raw =
    wrapper.booking && typeof wrapper.booking === "object"
      ? (wrapper.booking as JsonObject)
      : wrapper;

  return {
    id: raw.id == null ? undefined : String(raw.id),
    bookingRef: String(raw.bookingRef ?? raw.booking_ref ?? raw.ref ?? ""),
    status: stringValue(raw.status, "UNKNOWN").toUpperCase(),
    paymentStatus:
      stringValue(raw.paymentStatus, stringValue(raw.payment_status)).toUpperCase() ||
      undefined,
    otpStatus:
      stringValue(raw.otpStatus, stringValue(raw.otp_status)).toUpperCase() || undefined,
    showtimeId:
      String(raw.showtimeId ?? raw.showtime_id ?? "") || undefined,
    seatLabel:
      stringValue(raw.seatLabel, stringValue(raw.seat_label)) || undefined,
    amount: typeof raw.amount === "number" ? raw.amount : undefined,
    currency: stringValue(raw.currency, "BDT"),
    ticketRef:
      stringValue(raw.ticketRef, stringValue(raw.ticket_ref)) || undefined,
    expiresAt:
      stringValue(raw.expiresAt, stringValue(raw.expires_at)) || undefined,
  };
}

export const api = {
  async movies(): Promise<Movie[]> {
    const payload = await request<unknown>("/movies");
    return arrayFrom<JsonObject>(payload, ["movies", "data"]).map(normalizeMovie);
  },

  async showtimes(movieId: string): Promise<Showtime[]> {
    const payload = await request<unknown>(
      `/showtimes?movieId=${encodeURIComponent(movieId)}`,
    );
    return arrayFrom<JsonObject>(payload, ["showtimes", "data"])
      .map(normalizeShowtime)
      .filter((showtime) => !showtime.movieId || showtime.movieId === movieId);
  },

  async seats(showtimeId: string): Promise<Seat[]> {
    const payload = await request<unknown>(
      `/showtimes/${encodeURIComponent(showtimeId)}/seats`,
    );
    return arrayFrom<JsonObject>(payload, ["seats", "data"]).map(normalizeSeat);
  },

  async hold(showtimeId: string, seatLabel: string, userId: string): Promise<Hold> {
    const payload = await request<unknown>(
      `/showtimes/${encodeURIComponent(showtimeId)}/holds`,
      {
      method: "POST",
        body: JSON.stringify({ seatLabel, userId }),
      },
    );
    return normalizeHold(payload);
  },

  async sendOtp(bookingRef: string, phone: string): Promise<void> {
    await request(`/bookings/${encodeURIComponent(bookingRef)}/otp/send`, {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
  },

  async verifyOtp(bookingRef: string, code: string): Promise<void> {
    await request(`/bookings/${encodeURIComponent(bookingRef)}/otp/verify`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  async pay(bookingRef: string): Promise<Booking> {
    const payload = await request<unknown>(
      `/bookings/${encodeURIComponent(bookingRef)}/pay`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return normalizeBooking(payload);
  },

  async booking(bookingRef: string): Promise<Booking> {
    const payload = await request<unknown>(
      `/bookings/${encodeURIComponent(bookingRef)}`,
    );
    return normalizeBooking(payload);
  },
};
