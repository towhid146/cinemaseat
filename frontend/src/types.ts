export type Movie = {
  id: string;
  title: string;
  description?: string;
  durationMinutes?: number;
  posterUrl?: string;
};

export type Showtime = {
  id: string;
  movieId?: string;
  movieTitle?: string;
  theatreId?: string;
  theatreName: string;
  startsAt: string;
  price?: number;
  currency?: string;
};

export type SeatStatus = "AVAILABLE" | "HELD" | "CONFIRMED" | "BOOKED";

export type Seat = {
  label: string;
  status: SeatStatus;
  price?: number;
};

export type Hold = {
  id: string;
  bookingRef: string;
  showtimeId: string;
  seatLabel: string;
  expiresAt: string;
  status: string;
};

export type Booking = {
  id?: string;
  bookingRef: string;
  status: string;
  paymentStatus?: string;
  otpStatus?: string;
  showtimeId?: string;
  seatLabel?: string;
  amount?: number;
  currency?: string;
  ticketRef?: string;
  expiresAt?: string;
};
