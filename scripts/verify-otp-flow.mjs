const apiUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const gatewayUrl = (process.env.GATEWAY_DEBUG_URL ?? 'http://localhost:9000').replace(/\/$/, '');

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForBooking(ref, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await json(`${apiUrl}/api/bookings/${ref}`);
    if (predicate(current.body)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for booking ${ref}`);
}

const showtimes = (await json(`${apiUrl}/api/showtimes`)).body.showtimes;
if (!showtimes?.length) throw new Error('No seeded showtimes');
const showtimeId = showtimes[0].id;
const seats = (await json(`${apiUrl}/api/showtimes/${showtimeId}/seats`)).body.seats;
const seat = seats?.find((candidate) => candidate.status === 'AVAILABLE');
if (!seat) throw new Error('No available seat for the OTP test');

const hold = await json(`${apiUrl}/api/showtimes/${showtimeId}/holds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ seatLabel: seat.seatLabel, userId: `otp-test-${Date.now()}` })
});
if (hold.response.status !== 201) throw new Error(`Hold returned ${hold.response.status}`);
const ref = hold.body.bookingRef;

const sent = await json(`${apiUrl}/api/bookings/${ref}/otp/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mock-mode': 'deterministic' },
  body: JSON.stringify({ phone: '+8801700000000' })
});
if (sent.response.status !== 202 || !sent.body.gatewayAccepted) {
  throw new Error(`OTP send was not accepted: ${sent.response.status} ${JSON.stringify(sent.body)}`);
}

await new Promise((resolve) => setTimeout(resolve, 2_500));
const gatewayOtp = await json(`${gatewayUrl}/debug/otp/${encodeURIComponent(ref)}`);
if (!gatewayOtp.response.ok || !JSON.stringify(gatewayOtp.body).includes('123456')) {
  throw new Error(`Gateway debug record did not contain deterministic OTP 123456: ${JSON.stringify(gatewayOtp.body)}`);
}

const verified = await json(`${apiUrl}/api/bookings/${ref}/otp/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: '123456' })
});
if (verified.response.status !== 200 || !verified.body.verified) {
  throw new Error(`OTP verify failed: ${verified.response.status} ${JSON.stringify(verified.body)}`);
}

const payStartedAt = Date.now();
const payment = await json(`${apiUrl}/api/bookings/${ref}/pay`, {
  method: 'POST',
  headers: { 'x-mock-mode': 'deterministic' }
});
const payResponseMs = Date.now() - payStartedAt;
if (payment.response.status !== 202) throw new Error(`Pay returned ${payment.response.status}`);

const confirmed = await waitForBooking(ref, (booking) => booking.status === 'CONFIRMED');
console.log(JSON.stringify({
  gateway: 'real asifmahmoud414/mock-gateway container',
  deterministicOtp: '123456',
  bookingRef: ref,
  payResponseMs,
  status: confirmed.status,
  paymentStatus: confirmed.paymentStatus,
  otpStatus: confirmed.otpStatus,
  ticketRef: confirmed.ticketRef
}, null, 2));
