import { check, fail, sleep } from 'k6';
import { Counter, Gauge } from 'k6/metrics';
import {
  BASE_URL,
  SEAT_LABEL,
  SHOWTIME_ID,
  createHold,
  findSeat,
  getSeatMap,
} from './helpers.js';

const successfulHolds = new Counter('successful_holds');
const rejectedHolds = new Counter('rejected_holds');
const unexpectedResponses = new Counter('unexpected_responses');
const heldSeatMatches = new Gauge('held_seat_matches');

export const options = {
  scenarios: {
    same_seat_burst: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    successful_holds: ['count==1'],
    rejected_holds: ['count==99'],
    unexpected_responses: ['count==0'],
    held_seat_matches: ['value==1'],
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

  console.log(JSON.stringify({
    event: 'scenario_a_started',
    baseUrl: BASE_URL,
    showtimeId: SHOWTIME_ID,
    seatLabel: SEAT_LABEL,
    requests: 100,
  }));

  // All initialized VUs wait for the same timestamp, making this a single
  // contention burst instead of merely 100 quick sequential requests.
  return { burstAt: Date.now() + 1000 };
}

export default function (data) {
  const waitMs = data.burstAt - Date.now();
  if (waitMs > 0) {
    sleep(waitMs / 1000);
  }

  const response = createHold(`scenario-a-buyer-${__VU}-${__ITER}`);

  if (response.status === 201) successfulHolds.add(1);
  else if (response.status === 409) rejectedHolds.add(1);
  else unexpectedResponses.add(1);

  check(response, {
    'hold is accepted or cleanly rejected': (r) => r.status === 201 || r.status === 409,
  });
}

export function teardown() {
  const response = getSeatMap();
  const seat = findSeat(response);
  const matches = response.status === 200 && seat?.status === 'HELD' ? 1 : 0;
  heldSeatMatches.add(matches);

  check(response, {
    'seat map is readable after contention': (r) => r.status === 200,
    'contended seat is held exactly once': () => matches === 1,
  });
}

export function handleSummary(data) {
  const successes = data.metrics.successful_holds?.values?.count || 0;
  const rejections = data.metrics.rejected_holds?.values?.count || 0;
  const unexpected = data.metrics.unexpected_responses?.values?.count || 0;
  const report = {
    scenario: 'A - one seat, many buyers',
    baseUrl: BASE_URL,
    showtimeId: SHOWTIME_ID,
    seatLabel: SEAT_LABEL,
    requestsSent: successes + rejections + unexpected,
    successfulHolds: successes,
    cleanRejections: rejections,
    unexpectedResponses: unexpected,
    oversellCount: Math.max(0, successes - 1),
    seatMapHeldMatches: data.metrics.held_seat_matches?.values?.value || 0,
    thresholdsPassed: Object.values(data.metrics).every((metric) => !metric.thresholds ||
      Object.values(metric.thresholds).every((threshold) => threshold.ok)),
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;

  return {
    stdout: rendered,
    'scenario-a-summary.json': rendered,
  };
}
