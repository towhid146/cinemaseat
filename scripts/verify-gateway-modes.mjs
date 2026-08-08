const apiUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const gatewayUrl = (process.env.GATEWAY_DEBUG_URL ?? 'http://localhost:9000').replace(/\/$/, '');
const modes = ['success', 'fail', 'duplicate', 'timeout', 'race'];

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitFor(ref, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await json(`${apiUrl}/api/bookings/${ref}`);
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${ref}`);
}

const showtimes = (await json(`${apiUrl}/api/showtimes`)).body.showtimes;
if (!showtimes?.length) throw new Error('No seeded showtimes');
const showtimeId = showtimes[0].id;
const seatMap = (await json(`${apiUrl}/api/showtimes/${showtimeId}/seats`)).body.seats;
const available = seatMap.filter((seat) => seat.status === 'AVAILABLE');
if (available.length < modes.length) throw new Error('Need five available seats');

await json(`${gatewayUrl}/debug/reset`, { method: 'POST' });
const results = [];
for (let index = 0; index < modes.length; index += 1) {
  const mode = modes[index];
  const seat = available[index].seatLabel;
  const hold = await json(`${apiUrl}/api/showtimes/${showtimeId}/holds`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seatLabel: seat, userId: `force-${mode}` })
  });
  if (hold.response.status !== 201) throw new Error(`${mode}: hold returned ${hold.response.status}`);
  const ref = hold.body.bookingRef;
  const payStartedAt = Date.now();
  const pay = await json(`${apiUrl}/api/bookings/${ref}/pay`, {
    method: 'POST', headers: { 'x-mock-force': mode }
  });
  const payResponseMs = Date.now() - payStartedAt;
  if (pay.response.status !== 202) throw new Error(`${mode}: pay returned ${pay.response.status}`);

  let final;
  if (mode === 'fail') {
    final = await waitFor(ref, (booking) => booking.paymentStatus === 'FAILED');
  } else if (mode === 'timeout') {
    final = (await json(`${apiUrl}/api/bookings/${ref}`)).body;
    if (payResponseMs > 10_000) throw new Error(`timeout: /pay blocked for ${payResponseMs}ms`);
  } else {
    final = await waitFor(ref, (booking) => booking.paymentStatus === 'SUCCEEDED');
  }
  results.push({ mode, payResponseMs, payAcknowledged: pay.body.gatewayAccepted, bookingStatus: final.status, paymentStatus: final.paymentStatus });
}

console.log(JSON.stringify({ gateway: 'real asifmahmoud414/mock-gateway container', results }, null, 2));
if (results.find((result) => result.mode === 'fail')?.paymentStatus !== 'FAILED') process.exitCode = 1;
for (const mode of ['success', 'duplicate', 'race']) {
  if (results.find((result) => result.mode === mode)?.paymentStatus !== 'SUCCEEDED') process.exitCode = 1;
}
