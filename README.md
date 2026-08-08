# CinemaSeat

CinemaSeat is a full-stack movie-ticket booking platform built for **Zero to Production · Phase 2 · The Ultimate Hackathon** (IEEE CS CUET × Poridhi.io). It provides a seeded movie/theatre/showtime catalog, live seat availability, expiring holds, asynchronous payment and OTP flows, and confirmed ticket references.

The central guarantee is simple: **a showtime seat cannot be sold twice**. PostgreSQL—not process memory—owns that invariant through the authoritative booking lifecycle and a partial unique index on `(showtime_id, seat_label)` for active statuses.

## Current status

The repository contains the intended end-to-end stack:

- Node.js + TypeScript + Express modular-monolith API
- PostgreSQL schema, migrations, and seed catalog
- React + Vite booking UI
- Integration with `asifmahmoud414/mock-gateway:latest`; no replacement gateway is included
- Docker Compose services for the API, frontend, PostgreSQL, and the provided gateway
- Automated unit/integration/concurrency tests and k6 scenarios
- GitHub Actions CI/CD workflows and AWS provisioning/recovery scripts

Verification status:

- **Fresh-clone dependency/build verification:** PASSED locally (`npm ci`, typecheck, tests, production builds)
- **Compose runtime verification:** PASSED locally; API, frontend, PostgreSQL, and the provided gateway started from the checked-in Compose file
- **Public deployment:** PASSED on an AWS EC2 `t2.micro` behind an Application Load Balancer
- **Public health:** PASSED with HTTP `200` in 406.8 ms during final verification
- **Scenario A deployed result:** PASSED — 1 success, 99 rejections, 0 oversell
- **Scenario B deployed result:** PASSED — expiry observed and the seat was rebooked by a different user
- **Local Scenario A/B and gateway force-mode verification:** PASSED on 2026-08-08

The hackathon scope intentionally excludes an admin portal, seat selection across multiple seats in one hold, production user authentication, HTTPS/domain management, and multi-region deployment.

## Architecture

```text
                         POST /charge, /otp/*
                         Idempotency-Key
+----------------+      +----------------------+      +------------------------+
| React/Vite SPA |----->| Express/TypeScript   |----->| Provided flaky gateway |
| browse & book  | HTTP | modular monolith     |      | :9000                  |
+----------------+      |                      |<-----| signed async callback  |
                        | catalog              |      +------------------------+
                        | booking lifecycle    |
                        | payments/webhooks    |
                        | OTP                  |
                        +----------+-----------+
                                   |
                                   | transactions + unique constraints
                                   v
                        +----------------------+
                        | PostgreSQL           |
                        | catalog              |
                        | bookings/payments    |
                        | payments/OTP/events  |
                        +----------------------+
```

Catalog seats are immutable facts. Availability is derived from the authoritative booking row: no active booking means `AVAILABLE`, an unexpired active hold means `HELD`, and a completed booking means `CONFIRMED`. The partial unique index covers `HELD`, `AWAITING_OTP`, `PAYMENT_PENDING`, and `CONFIRMED`. The hold TTL comes from `HOLD_TTL_SECONDS`.

Payment is asynchronous. The API starts a charge with a stable idempotency key and returns while the booking is `PAYMENT_PENDING`. The gateway callback is matched by `booking_ref` so a forced early callback is safe, its HMAC is checked over the raw body, and its `event_id` is inserted in the same transaction as the state change. Duplicate and unknown events receive a 2xx response. Payment and OTP outcomes are persisted independently; both gates must succeed before confirmation.

## Run locally from a clean clone

Prerequisites: Git, Docker Engine/Desktop, and Docker Compose v2. Ports `3000`, `8080`, `5432`, and `9000` must be free.

```bash
git clone https://github.com/towhid146/cinemaseat.git
cd cinemaseat
docker compose up --build
```

No local Node.js or PostgreSQL installation is required. Compose creates the database, applies the schema/seeds, and starts all application services. Once the containers are healthy:

- Frontend: <http://localhost:8080>
- API health: <http://localhost:3000/health>
- Gateway health/debug service: <http://localhost:9000/health>

Check health without involving the gateway:

```bash
curl --fail http://localhost:3000/health
```

The API health route is intentionally independent of gateway health, so browsing, seat holds, and `/health` continue to work if the gateway is unavailable. Stop the stack with `docker compose down`. To discard all local database state and reseed on the next start, use `docker compose down -v`.

### Configuration

Compose provides working local defaults. Important overrides include:

| Variable | Purpose | Local default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Compose service URL |
| `PORT` | API listen port | `3000` |
| `HOLD_TTL_SECONDS` | Seconds before an incomplete hold can be acquired again | Compose value |
| `GATEWAY_URL` | Server-to-server gateway address | `http://gateway:9000` |
| `GATEWAY_CALLBACK_URL` | Callback reachable from the gateway container | `http://api:3000/webhooks/payment` |
| `GATEWAY_SECRET` | HMAC-SHA256 callback secret | `z2p-2026-secret` for local gateway only |
| `VITE_API_URL` | Browser-visible API base URL | `/api` through the frontend proxy |
| `FRONTEND_PORT` | Published frontend port | `8080` |

Never change the container callback URL to `localhost`: from inside the gateway container, `localhost` is the gateway itself.

## Judge-facing API contract

The examples below are the exact hold and seat-map interface. Replace `1` with a seeded showtime identifier returned by the catalog API.

### Fetch a seat map

```http
GET /api/showtimes/1/seats HTTP/1.1
Host: localhost:3000
```

Equivalent curl request:

```bash
curl http://localhost:3000/api/showtimes/1/seats
```

Successful response (`200 OK`):

```json
{
  "showtimeId": 1,
  "seats": [
    {
      "seatLabel": "A1",
      "rowNumber": 1,
      "seatNumber": 1,
      "price": 450,
      "currency": "BDT",
      "status": "AVAILABLE",
      "expiresAt": null
    },
    {
      "seatLabel": "A2",
      "rowNumber": 1,
      "seatNumber": 2,
      "price": 450,
      "currency": "BDT",
      "status": "HELD",
      "expiresAt": "2026-08-08T05:30:30.000Z"
    }
  ]
}
```

`status` is exactly one of `AVAILABLE`, `HELD`, or `CONFIRMED`. `expiresAt` is an ISO-8601 timestamp for a current hold and `null` otherwise.

### Hold one seat

```http
POST /api/showtimes/1/holds HTTP/1.1
Host: localhost:3000
Content-Type: application/json

{
  "seatLabel": "A1",
  "userId": "judge-user-001"
}
```

Equivalent curl request:

```bash
curl -i -X POST http://localhost:3000/api/showtimes/1/holds \
  -H 'Content-Type: application/json' \
  -d '{"seatLabel":"A1","userId":"judge-user-001"}'
```

Winning request (`201 Created`):

```json
{
  "bookingRef": "bk_01HZX...",
  "status": "HELD",
  "seatLabel": "A1",
  "showtimeId": 1,
  "expiresAt": "2026-08-08T05:30:30.000Z"
}
```

Every competing or already-sold request (`409 Conflict`):

```json
{
  "error": {
    "code": "SEAT_UNAVAILABLE",
    "message": "Seat unavailable"
  }
}
```

For 100 simultaneous requests targeting the same `showtimeId` and `seatLabel`, the database constraint admits one `201` and the API translates all 99 losers to `409`.

### Complete a booking

Given the `bookingRef` returned by the hold:

```text
POST /api/bookings/:bookingRef/otp/send    { "phone": "+8801700000000" }
POST /api/bookings/:bookingRef/otp/verify  { "code": "123456" }
POST /api/bookings/:bookingRef/pay
GET  /api/bookings/:bookingRef
```

The pay route returns `202 PAYMENT_PENDING` after starting the charge; it never waits for the asynchronous callback. Clients poll the booking route for state. Gateway test-control headers `X-Mock-Mode` and `X-Mock-Force` may be sent to the pay route and are forwarded to `/charge` for integration testing.

## Gateway correctness

- `/charge` uses one stable `Idempotency-Key` per booking, including retries.
- The callback URL uses the Compose DNS name `http://api:3000`, not `localhost`.
- `/webhooks/payment` captures the raw request bytes and verifies `X-Signature` with HMAC-SHA256.
- Webhook `event_id` is unique in `webhook_events`; event insertion and booking/payment mutation share one database transaction.
- Matching by `booking_ref` handles a callback that races ahead of the local `payment_id` write.
- Duplicate, early, and unrecognized events return 2xx so the gateway does not create a retry storm.
- Payment success/failure and OTP verified/unverified remain independent persisted states.

The required gateway modes are `success`, `fail`, `duplicate`, `timeout`, and `race`. A reproducible integration run against the real gateway container, rather than a locally built mock, is the acceptance criterion.

Observed locally against the provided gateway container:

| Force mode | `/pay` response | Observed result |
|---|---:|---|
| `success` | 292 ms | `SUCCEEDED`, booking awaiting OTP |
| `fail` | 45 ms | `FAILED`, seat released |
| `duplicate` | 149 ms | One stable `SUCCEEDED` payment |
| `timeout` | 5,033 ms | `202`, safe retry with the same idempotency key |
| `race` | 46 ms | Early callback matched by `booking_ref`, `SUCCEEDED` |

## Tests and load scenarios

Install the workspace dependencies, then run the same checks used by CI:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The local unit suite contains 6 passing tests. PostgreSQL-backed tests add the exact 100-request contention, expiry/rebooking, callback-race, and duplicate-event assertions whenever `DATABASE_URL` is set; CI provisions that database automatically. Run every forced behavior against the real Compose gateway with:

```bash
node scripts/verify-gateway-modes.mjs
```

That script sends `success`, `fail`, `duplicate`, `timeout`, and `race` through the public `/pay` route and records response latency plus eventual payment state. The k6 scripts under `load-tests/` target an externally supplied base URL and should run outside the application host:

```bash
k6 run -e BASE_URL=http://localhost:3000 -e SHOWTIME_ID=1 -e SEAT_LABEL=A1 load-tests/scenario-a-contention.js
k6 run -e BASE_URL=http://localhost:3000 -e SHOWTIME_ID=1 -e SEAT_LABEL=A2 -e HOLD_TTL_SECONDS=5 load-tests/scenario-b-expiry.js
```

### Scenario A — one seat, 100 buyers

Acceptance criteria:

- Requests sent: 100
- Successful holds: 1
- Clean `409` rejections: 99
- Oversold seats: 0
- Final seat map: the selected seat appears exactly once as `HELD`

**Observed local k6 result (2026-08-08):** 100 requests, 1 successful hold, 99 clean `409` rejections, 0 unexpected responses, 0 oversell, and exactly 1 held-seat match in the final seat map. All thresholds passed.

**Observed deployed k6 result (2026-08-08):** against showtime `1`, seat `A1`, exactly 1 of 100 simultaneous buyers received `201`; the other 99 received clean `409` responses. There were 0 unexpected responses, 0 oversold seats, and the final seat map contained exactly 1 held-seat match. All thresholds passed.

### Scenario B — abandoned hold

Acceptance sequence:

1. Run the stack with a short `HOLD_TTL_SECONDS`.
2. User A receives a hold and does not complete payment/OTP.
3. After `expiresAt`, the seat map reports the seat as `AVAILABLE`.
4. User B successfully receives a new hold for that same showtime seat.

**Observed local k6 result (2026-08-08):** with `HOLD_TTL_SECONDS=5`, user A held showtime `1` seat `A2`; the seat was `AVAILABLE` after 7,029 ms; user B then received `201`. Expiry and rebooking thresholds passed.

**Observed deployed k6 result (2026-08-08):** with `HOLD_TTL_SECONDS=10`, user A held showtime `1` seat `A2`; expiry was observed after 12,352 ms and a different user immediately received `201` for the same seat. Both thresholds passed.

## Deployment

**Deployed URL: <http://cinemaseat-08081451-1786809187.ap-southeast-1.elb.amazonaws.com>**

The production stack runs on an AWS EC2 `t2.micro` in `ap-southeast-1` behind an internet-facing Application Load Balancer. Only load-balancer HTTP traffic reaches the instance; PostgreSQL and the gateway are not publicly exposed. The deployment uses `HOLD_TTL_SECONDS=10` so abandoned-hold behavior can be demonstrated quickly.

Provisioning is reproducible with `scripts/deploy-aws.ps1`. `scripts/verify-deployed.ps1` runs k6 from the operator's machine and writes the deployed Scenario A/B JSON evidence under the ignored `outputs/` directory.

CI runs on pull requests and default-branch pushes. CD is scoped to default-branch pushes and activates when the production SSH variables/secrets documented in `.github/workflows/cd.yml` are configured. The initial AWS infrastructure deployment was performed with the checked-in provisioning script; credentials are prompted securely and never written to the repository.

## Attribution

The payment/OTP dependency is the hackathon-provided image `asifmahmoud414/mock-gateway:latest`. The application uses standard open-source Node.js, React, PostgreSQL, Docker, and k6 tooling declared in the repository; no custom replacement gateway is included.
