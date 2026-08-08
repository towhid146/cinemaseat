import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  SEAT_LABEL,
  SHOWTIME_ID,
  createHold,
  findSeat,
  getSeatMap,
} from './helpers.js';

const expiryObserved = new Counter('expiry_observed');
const rebookSucceeded = new Counter('rebook_succeeded');
const observedExpiryMs = new Trend('observed_expiry_ms', true);
const holdTtlSeconds = Number(__ENV.HOLD_TTL_SECONDS || 5);
const expiryGraceSeconds = Number(__ENV.EXPIRY_GRACE_SECONDS || 2);

export const options = {
  scenarios: {
    abandoned_hold: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${Math.max(30, holdTtlSeconds + expiryGraceSeconds + 15)}s`,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    expiry_observed: ['count==1'],
    rebook_succeeded: ['count==1'],
  },
};

export function setup() {
  const response = getSeatMap();
  const seat = findSeat(response);
  if (response.status !== 200 || !seat) {
    fail(`Precondition failed: ${SEAT_LABEL} was not found on showtime ${SHOWTIME_ID}`);
  }
  if (seat.status !== 'AVAILABLE') {
    fail(`Precondition failed: ${SEAT_LABEL} must be AVAILABLE, got ${seat.status}`);
  }
}

export default function () {
  const timeline = [];
  const startedAt = Date.now();
  const first = createHold('scenario-b-abandoning-user');
  timeline.push({ atMs: 0, event: 'first_hold', status: first.status });

  if (first.status !== 201) fail(`First hold failed with HTTP ${first.status}`);

  const heldMap = getSeatMap();
  const heldSeat = findSeat(heldMap);
  check(heldMap, {
    'seat is HELD before expiry': () => heldSeat?.status === 'HELD',
  });

  sleep(holdTtlSeconds + expiryGraceSeconds);

  const expiredAt = Date.now();
  const expiredMap = getSeatMap();
  const expiredSeat = findSeat(expiredMap);
  const isAvailable = expiredSeat?.status === 'AVAILABLE';
  timeline.push({
    atMs: expiredAt - startedAt,
    event: 'expiry_check',
    status: expiredSeat?.status || 'UNKNOWN',
  });

  if (isAvailable) expiryObserved.add(1);
  observedExpiryMs.add(expiredAt - startedAt);
  check(expiredMap, { 'abandoned hold returns to AVAILABLE': () => isAvailable });

  const second = createHold('scenario-b-second-user');
  timeline.push({
    atMs: Date.now() - startedAt,
    event: 'second_user_hold',
    status: second.status,
  });
  if (second.status === 201) rebookSucceeded.add(1);
  check(second, { 'different user can rebook expired seat': (r) => r.status === 201 });

  console.log(JSON.stringify({
    event: 'scenario_b_timeline',
    baseUrl: BASE_URL,
    showtimeId: SHOWTIME_ID,
    seatLabel: SEAT_LABEL,
    configuredHoldTtlSeconds: holdTtlSeconds,
    timeline,
  }));
}

export function handleSummary(data) {
  const report = {
    scenario: 'B - abandoned hold expires and is rebooked',
    baseUrl: BASE_URL,
    showtimeId: SHOWTIME_ID,
    seatLabel: SEAT_LABEL,
    configuredHoldTtlSeconds: holdTtlSeconds,
    expiryObserved: (data.metrics.expiry_observed?.values?.count || 0) === 1,
    rebookSucceeded: (data.metrics.rebook_succeeded?.values?.count || 0) === 1,
    observedExpiryMs: data.metrics.observed_expiry_ms?.values?.avg || null,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;

  return {
    stdout: rendered,
    'scenario-b-summary.json': rendered,
  };
}
