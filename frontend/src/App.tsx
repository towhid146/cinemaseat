import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import type { Booking, Hold, Movie, Seat, Showtime } from "./types";

const TERMINAL_BOOKING_STATUSES = new Set([
  "CONFIRMED",
  "PAYMENT_FAILED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

function makeUserId(): string {
  try {
    const saved = localStorage.getItem("cinemaseat-user-id");
    if (saved) return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  // crypto.randomUUID() is restricted to secure contexts. The deployed HTTP
  // demo still needs a non-security-sensitive guest correlation identifier.
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const created = `guest-${randomId.replaceAll("-", "").slice(0, 12)}`;

  try {
    localStorage.setItem("cinemaseat-user-id", created);
  } catch {
    // The in-memory value remains usable for this page session.
  }
  return created;
}

function messageFrom(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "That seat was just taken. Choose another available seat.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatTime(value: string): string {
  if (!value) return "Time TBA";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

function App() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [showtimes, setShowtimes] = useState<Showtime[]>([]);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [movie, setMovie] = useState<Movie>();
  const [showtime, setShowtime] = useState<Showtime>();
  const [selectedSeat, setSelectedSeat] = useState<string>();
  const [hold, setHold] = useState<Hold>();
  const [booking, setBooking] = useState<Booking>();
  const [userId, setUserId] = useState(makeUserId);
  const [phone, setPhone] = useState("+8801");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const bookingRef = booking?.bookingRef || hold?.bookingRef;

  const loadMovies = useCallback(async () => {
    setBusy("movies");
    setError("");
    try {
      setMovies(await api.movies());
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    void loadMovies();
  }, [loadMovies]);

  useEffect(() => {
    if (!movie) return;
    let current = true;
    setBusy("showtimes");
    setError("");
    setShowtime(undefined);
    setSeats([]);
    void api
      .showtimes(movie.id)
      .then((items) => current && setShowtimes(items))
      .catch((caught) => current && setError(messageFrom(caught)))
      .finally(() => current && setBusy(""));
    return () => {
      current = false;
    };
  }, [movie]);

  const refreshSeats = useCallback(async () => {
    if (!showtime) return;
    try {
      setSeats(await api.seats(showtime.id));
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }, [showtime]);

  useEffect(() => {
    if (!showtime) return;
    setSelectedSeat(undefined);
    setHold(undefined);
    setBooking(undefined);
    setOtpSent(false);
    setOtpVerified(false);
    setBusy("seats");
    setError("");
    void refreshSeats().finally(() => setBusy(""));
  }, [showtime, refreshSeats]);

  useEffect(() => {
    if (!bookingRef) return;
    let current = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const latest = await api.booking(bookingRef);
        if (!current) return;
        setBooking(latest);
        if (!TERMINAL_BOOKING_STATUSES.has(latest.status)) {
          timer = window.setTimeout(poll, 1500);
        } else {
          void refreshSeats();
        }
      } catch {
        if (current) timer = window.setTimeout(poll, 2500);
      }
    };

    timer = window.setTimeout(poll, 1000);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [bookingRef, refreshSeats]);

  const rows = useMemo(() => {
    return seats.reduce<Record<string, Seat[]>>((grouped, seat) => {
      const row = seat.label.match(/^[A-Za-z]+/)?.[0] || "Seats";
      grouped[row] ||= [];
      grouped[row].push(seat);
      return grouped;
    }, {});
  }, [seats]);

  async function createHold() {
    if (!showtime || !selectedSeat || !userId.trim()) return;
    setBusy("hold");
    setError("");
    try {
      const created = await api.hold(showtime.id, selectedSeat, userId.trim());
      setHold(created);
      await refreshSeats();
    } catch (caught) {
      setError(messageFrom(caught));
      await refreshSeats();
    } finally {
      setBusy("");
    }
  }

  async function sendOtp() {
    if (!bookingRef || !phone.trim()) return;
    setBusy("send-otp");
    setError("");
    try {
      await api.sendOtp(bookingRef, phone.trim());
      setOtpSent(true);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy("");
    }
  }

  async function verifyOtp() {
    if (!bookingRef || !otp.trim()) return;
    setBusy("verify-otp");
    setError("");
    try {
      await api.verifyOtp(bookingRef, otp.trim());
      setOtpVerified(true);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy("");
    }
  }

  async function pay() {
    if (!bookingRef) return;
    setBusy("pay");
    setError("");
    try {
      setBooking(await api.pay(bookingRef));
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy("");
    }
  }

  function reset() {
    setMovie(undefined);
    setShowtime(undefined);
    setSelectedSeat(undefined);
    setHold(undefined);
    setBooking(undefined);
    setOtp("");
    setOtpSent(false);
    setOtpVerified(false);
    setError("");
  }

  const confirmed = booking?.status === "CONFIRMED";
  const expired = booking?.status === "EXPIRED";

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={reset} aria-label="CinemaSeat home">
          <span className="brand-mark">C</span>
          <span>CinemaSeat</span>
        </button>
        <span className="secure-label">Concurrency-safe booking</span>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">Now showing</p>
          <h1>Pick a film. Claim your seat.</h1>
          <p>Live availability, short holds, and instant ticket confirmation.</p>
        </section>

        <nav className="steps" aria-label="Booking progress">
          <span className={!movie ? "active" : "done"}>1 Movie</span>
          <span className={movie && !showtime ? "active" : showtime ? "done" : ""}>
            2 Showtime
          </span>
          <span className={showtime && !hold ? "active" : hold ? "done" : ""}>
            3 Seat
          </span>
          <span className={hold && !confirmed ? "active" : confirmed ? "done" : ""}>
            4 Confirm
          </span>
        </nav>

        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
          </div>
        )}

        {!movie && (
          <section>
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>Choose a movie</h2>
              </div>
              <button className="text-button" onClick={loadMovies}>Refresh</button>
            </div>
            {busy === "movies" ? (
              <Loading label="Loading movies" />
            ) : movies.length ? (
              <div className="movie-grid">
                {movies.map((item) => (
                  <button className="movie-card" key={item.id} onClick={() => setMovie(item)}>
                    <div className="poster">
                      {item.posterUrl ? <img src={item.posterUrl} alt="" /> : <span>{item.title.charAt(0)}</span>}
                    </div>
                    <div>
                      <h3>{item.title}</h3>
                      <p>{item.description || "Book seats for an upcoming show."}</p>
                      {item.durationMinutes && <small>{item.durationMinutes} min</small>}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Empty text="No movies are available yet." action={loadMovies} />
            )}
          </section>
        )}

        {movie && !showtime && (
          <section>
            <Back onClick={() => setMovie(undefined)} />
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 2 · {movie.title}</p>
                <h2>Choose a showtime</h2>
              </div>
            </div>
            {busy === "showtimes" ? (
              <Loading label="Loading showtimes" />
            ) : showtimes.length ? (
              <div className="showtime-grid">
                {showtimes.map((item) => (
                  <button className="showtime-card" key={item.id} onClick={() => setShowtime(item)}>
                    <strong>{formatTime(item.startsAt)}</strong>
                    <span>{item.theatreName}</span>
                    {item.price != null && <small>{item.price} {item.currency || "BDT"}</small>}
                  </button>
                ))}
              </div>
            ) : (
              <Empty text="No showtimes found for this movie." action={() => setMovie(undefined)} />
            )}
          </section>
        )}

        {showtime && !hold && (
          <section>
            <Back onClick={() => setShowtime(undefined)} />
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 3 · {movie?.title}</p>
                <h2>Select one seat</h2>
                <p>{formatTime(showtime.startsAt)} · {showtime.theatreName}</p>
              </div>
              <button className="text-button" onClick={() => void refreshSeats()}>Refresh seats</button>
            </div>

            <div className="seat-panel">
              <div className="screen"><span>SCREEN</span></div>
              {busy === "seats" ? (
                <Loading label="Loading live seat map" />
              ) : (
                <div className="seat-map">
                  {Object.entries(rows).map(([row, rowSeats]) => (
                    <div className="seat-row" key={row}>
                      <span className="row-label">{row}</span>
                      <div>
                        {rowSeats.map((seat) => {
                          const available = seat.status === "AVAILABLE";
                          return (
                            <button
                              key={seat.label}
                              className={`seat ${seat.status.toLowerCase()} ${selectedSeat === seat.label ? "selected" : ""}`}
                              disabled={!available}
                              title={`${seat.label}: ${seat.status.toLowerCase()}`}
                              aria-label={`Seat ${seat.label}, ${seat.status.toLowerCase()}`}
                              aria-pressed={selectedSeat === seat.label}
                              onClick={() => setSelectedSeat(seat.label)}
                            >
                              {seat.label.replace(/^[A-Za-z]+/, "") || seat.label}
                            </button>
                          );
                        })}
                      </div>
                      <span className="row-label">{row}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="legend">
                <span><i className="available" />Available</span>
                <span><i className="selected" />Selected</span>
                <span><i className="held" />Held</span>
                <span><i className="confirmed" />Sold</span>
              </div>
            </div>

            <div className="checkout-bar">
              <label>
                Guest ID
                <input value={userId} onChange={(event) => setUserId(event.target.value)} />
              </label>
              <div>
                <small>Selected seat</small>
                <strong>{selectedSeat || "—"}</strong>
              </div>
              <button className="primary" disabled={!selectedSeat || !userId.trim() || busy === "hold"} onClick={createHold}>
                {busy === "hold" ? "Claiming…" : "Hold this seat"}
              </button>
            </div>
          </section>
        )}

        {hold && showtime && !confirmed && (
          <section className="payment-layout">
            <div>
              <Back onClick={reset} label="Start over" />
              <p className="eyebrow">Step 4</p>
              <h2>{expired ? "Your hold expired" : "Verify and pay"}</h2>
              <p className="muted">Your seat is temporarily reserved. Complete verification and payment before the hold expires.</p>

              {expired && (
                <div className="flow-card">
                  <div className="flow-number">!</div>
                  <div className="flow-content">
                    <h3>Reservation released</h3>
                    <p>No OTP or payment was processed. Choose another seat to continue.</p>
                    <button className="primary" onClick={reset}>Choose another seat</button>
                  </div>
                </div>
              )}

              <div className="flow-card" hidden={expired}>
                <div className="flow-number">1</div>
                <div className="flow-content">
                  <h3>Verify your phone</h3>
                  {!otpSent ? (
                    <div className="input-action">
                      <input aria-label="Phone number" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8801…" />
                      <button onClick={sendOtp} disabled={!phone.trim() || busy === "send-otp"}>{busy === "send-otp" ? "Sending…" : "Send OTP"}</button>
                    </div>
                  ) : !otpVerified ? (
                    <div className="input-action">
                      <input aria-label="OTP code" inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value)} placeholder="6-digit code" />
                      <button onClick={verifyOtp} disabled={!otp.trim() || busy === "verify-otp"}>{busy === "verify-otp" ? "Checking…" : "Verify"}</button>
                    </div>
                  ) : (
                    <p className="success-line">✓ Phone verified</p>
                  )}
                  {otpSent && !otpVerified && <button className="text-button resend" onClick={sendOtp}>Resend code</button>}
                </div>
              </div>

              <div className="flow-card" hidden={expired}>
                <div className="flow-number">2</div>
                <div className="flow-content">
                  <h3>Start payment</h3>
                  <p>The payment gateway will confirm asynchronously. This page updates automatically.</p>
                  <button className="primary" onClick={pay} disabled={!otpVerified || busy === "pay"}>
                    {busy === "pay" ? "Starting…" : booking?.status === "PAYMENT_PENDING" ? "Retry payment safely" : "Pay securely"}
                  </button>
                </div>
              </div>
            </div>

            <aside className="summary-card">
              <p className="eyebrow">Order summary</p>
              <h3>{movie?.title}</h3>
              <dl>
                <div><dt>Show</dt><dd>{formatTime(showtime.startsAt)}</dd></div>
                <div><dt>Theatre</dt><dd>{showtime.theatreName}</dd></div>
                <div><dt>Seat</dt><dd>{hold.seatLabel || selectedSeat}</dd></div>
                <div><dt>Reference</dt><dd>{bookingRef || "Creating…"}</dd></div>
                <div><dt>Hold ends</dt><dd>{formatTime(hold.expiresAt)}</dd></div>
                {booking?.status && <div><dt>Status</dt><dd><Status value={booking.status} /></dd></div>}
              </dl>
            </aside>
          </section>
        )}

        {confirmed && booking && hold && showtime && (
          <section className="confirmation">
            <div className="checkmark">✓</div>
            <p className="eyebrow">Booking confirmed</p>
            <h2>Your seat is all yours.</h2>
            <p>Keep this reference ready when you arrive at the theatre.</p>
            <div className="ticket">
              <div className="ticket-main">
                <span className="ticket-brand">CinemaSeat</span>
                <h3>{movie?.title}</h3>
                <div className="ticket-grid">
                  <div><small>Date & time</small><strong>{formatTime(showtime.startsAt)}</strong></div>
                  <div><small>Seat</small><strong>{booking.seatLabel || hold.seatLabel || selectedSeat}</strong></div>
                  <div><small>Theatre</small><strong>{showtime.theatreName}</strong></div>
                  <div><small>Status</small><strong>Confirmed</strong></div>
                </div>
              </div>
              <div className="ticket-stub">
                <div className="qr-pattern" aria-hidden="true" />
                <small>Ticket reference</small>
                <strong>{booking.ticketRef || booking.bookingRef}</strong>
              </div>
            </div>
            <button className="primary" onClick={reset}>Book another ticket</button>
          </section>
        )}
      </main>

      <footer>Built for Zero to Production · Phase 2</footer>
    </>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="loading"><span />{label}…</div>;
}

function Empty({ text, action }: { text: string; action: () => void }) {
  return <div className="empty"><p>{text}</p><button className="text-button" onClick={action}>Try again</button></div>;
}

function Back({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return <button className="back" onClick={onClick}>← {label}</button>;
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value.replaceAll("_", " ")}</span>;
}

export default App;
