# CinemaSeat testing checklist

This file extracts every test and judge hook from the hackathon problem statement and gateway technical reference. Tests use the provided `asifmahmoud414/mock-gateway:latest` container; the repository contains no replacement gateway.

## One-command local acceptance run

Start the clean stack, then run the acceptance script from the host (not inside the application VM):

```powershell
docker compose up -d --build
.\scripts\verify-local.ps1
```

The script runs the frontend smoke check, Scenario A, Scenario B with a temporary five-second hold TTL, all five payment force modes, the deterministic real-gateway OTP flow, and the gateway-down isolation check. It restores the normal API and gateway containers before exiting.

## Required judge hooks

| Requirement | Acceptance test | Implementation |
|---|---|---|
| Health is fast and independent | Stop `gateway`; `GET /health` must stay `200` and complete in under one second | `scripts/verify-fault-isolation.ps1` |
| TTL is configurable | Recreate API with `HOLD_TTL_SECONDS=5`, observe expiry, then rebook the same seat | Scenario B / config unit test |
| Hold contract is exact | `POST /api/showtimes/:id/holds` with `seatLabel` and `userId` | README judge-facing contract |
| Seat-map contract is exact | `GET /api/showtimes/:id/seats` | README judge-facing contract |
| Clean-clone startup | `docker compose up --build` with no manual database work | Compose health checks and API startup migration/seed |

## Core correctness tests

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The test suite covers:

- 100 simultaneous requests for the exact same showtime seat: one winner, 99 conflicts.
- A short hold expiring and a different user acquiring that exact seat.
- The PostgreSQL partial unique index as the cross-process seat lock.
- Duplicate `event_id` callbacks mutating booking/payment state only once.
- A callback racing ahead of the local gateway `payment_id` write.
- HMAC-SHA256 verification over the raw callback body.
- Payment and OTP webhook endpoints returning 2xx for invalid or unrecognized deliveries.
- `HOLD_TTL_SECONDS` being read from the environment.
- OTP requests using the distinct container-reachable callback URL and forwarding deterministic mode.

## Gateway integration tests

Run all documented payment behaviors against the real container:

```bash
npm run verify:gateway
```

| Header | Expected result |
|---|---|
| `X-Mock-Force: success` | Callback succeeds; payment becomes `SUCCEEDED` |
| `X-Mock-Force: fail` | Payment becomes `FAILED`; seat is released |
| `X-Mock-Force: duplicate` | Same `event_id` is accepted twice but processed once |
| `X-Mock-Force: timeout` | `/pay` returns `202`; retry keeps the same idempotency key |
| `X-Mock-Force: race` | Early callback is matched by `booking_ref` |

Additional gateway assertions:

- `/charge` always receives the stable `Idempotency-Key` `charge:<booking_ref>`.
- Payment callback URL is `http://api:3000/webhooks/payment` in Compose.
- OTP callback URL is `http://api:3000/webhooks/otp` in Compose.
- Payment callbacks validate `X-Signature` over the byte-exact request body.
- Duplicate, unknown, malformed, and invalid-signature callback requests receive HTTP 2xx.

## OTP integration

The official deterministic OTP is `123456`, not `111111`. Verify the complete OTP and payment lifecycle through the real gateway:

```bash
npm run verify:otp
```

The script sends OTP with `X-Mock-Mode: deterministic`, checks `/debug/otp/:bookingRef`, verifies `123456`, initiates deterministic payment, waits for the asynchronous callback, and requires a `CONFIRMED` booking with a ticket reference.

Normal mode must also tolerate delayed or missing OTP delivery, wrong/expired codes (`400`), and lockout after five attempts (`429`). Payment and OTP are separate state gates; neither implies the other succeeded.

## Load tests

Run k6 outside the application host.

### Scenario A — required

```bash
k6 run -e BASE_URL=http://localhost:3000 -e SHOWTIME_ID=1 -e SEAT_LABEL=A1 load-tests/scenario-a-contention.js
```

Acceptance: exactly 100 requests for one seat in one burst, 1 successful hold, 99 clean `409` responses, 0 oversell, and exactly one held entry in the final seat map.

### Scenario B — required

```bash
k6 run -e BASE_URL=http://localhost:3000 -e SHOWTIME_ID=1 -e SEAT_LABEL=A2 -e HOLD_TTL_SECONDS=5 load-tests/scenario-b-expiry.js
```

Acceptance: user A holds and abandons the seat; after expiry it becomes available; user B then receives `201` for that exact seat.

### Scenario C — bonus

```bash
k6 run -e BASE_URL=http://localhost:3000 -e SHOWTIME_ID=1 load-tests/scenario-c-breakpoint.js
```

Report the first load stage where p95 latency turns upward, the first stage with errors, and the measured bottleneck. Do not compare raw throughput across teams or run k6 on the application VM.

## Delivery checks

- CI runs on pull requests and pushes to `main`, provisions PostgreSQL, and gates typecheck, tests, builds, and Compose validation.
- CD runs only on pushes to `main` when deployment secrets are configured.
- Run `scripts/verify-deployed.ps1` from the operator machine to repeat required Scenarios A and B against the public URL and save JSON evidence under `outputs/`.
- Confirm the frontend, `/health`, exact hold request, and exact seat-map request from the deployed URL before code freeze.
