import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const SHOWTIME_ID = __ENV.SHOWTIME_ID || '1';
export const SEAT_LABEL = __ENV.SEAT_LABEL || 'A1';

export function seatMapUrl(showtimeId = SHOWTIME_ID) {
  return `${BASE_URL}/api/showtimes/${encodeURIComponent(showtimeId)}/seats`;
}

export function holdUrl(showtimeId = SHOWTIME_ID) {
  return `${BASE_URL}/api/showtimes/${encodeURIComponent(showtimeId)}/holds`;
}

export function getSeatMap(showtimeId = SHOWTIME_ID) {
  return http.get(seatMapUrl(showtimeId), { tags: { operation: 'seat_map' } });
}

export function findSeat(response, seatLabel = SEAT_LABEL) {
  if (response.status !== 200) return null;

  try {
    const body = response.json();
    return (body.seats || []).find((seat) => seat.seatLabel === seatLabel) || null;
  } catch (_) {
    return null;
  }
}

export function createHold(userId, seatLabel = SEAT_LABEL, showtimeId = SHOWTIME_ID) {
  return http.post(
    holdUrl(showtimeId),
    JSON.stringify({ seatLabel, userId }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { operation: 'hold', seat_label: seatLabel },
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
}

