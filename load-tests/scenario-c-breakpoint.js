import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import {
  SEAT_LABEL,
  createHold,
  getSeatMap,
} from './helpers.js';

const unexpectedErrorRate = new Rate('unexpected_error_rate');
const seatLabels = (__ENV.SEAT_LABELS || SEAT_LABEL).split(',').map((value) => value.trim());

export const options = {
  scenarios: {
    browse_ramp: {
      executor: 'ramping-vus',
      exec: 'browse',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
    hold_ramp: {
      executor: 'ramping-vus',
      exec: 'hold',
      startTime: '15s',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '30s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    unexpected_error_rate: ['rate<0.05'],
  },
};

export function browse() {
  const response = getSeatMap();
  const ok = response.status === 200;
  unexpectedErrorRate.add(!ok, { operation: 'seat_map' });
  check(response, { 'seat map returns 200': (r) => r.status === 200 });
  sleep(0.25);
}

export function hold() {
  const label = seatLabels[(__VU + __ITER) % seatLabels.length];
  const response = createHold(`scenario-c-${__VU}-${__ITER}`, label);
  const expected = response.status === 201 || response.status === 409;
  unexpectedErrorRate.add(!expected, { operation: 'hold' });
  check(response, { 'hold returns 201 or business-conflict 409': () => expected });
  sleep(0.25);
}

