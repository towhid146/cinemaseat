# CinemaSeat Engineering Decisions

This file records the three architectural decisions that most strongly shaped the hackathon build.

## 1. Modular monolith instead of microservices

### Options considered

- Separate catalog, booking, payment, and OTP services, each independently deployed.
- One unstructured API application.
- A modular monolith: one Node.js/TypeScript API process with explicit catalog, booking, payment, and OTP boundaries.

### Decision

Use a modular monolith built with Node.js, TypeScript, and Express, backed by PostgreSQL. The React/Vite frontend is a separate build artifact, while the server-side business capabilities remain modules in one API deployment.

### Why

The booking transaction and the payment-webhook transaction both need a single, authoritative database boundary. A monolith keeps those transactions local, minimizes deployment and observability overhead, and is realistic to build and verify in an eight-hour hackathon. Module boundaries retain a clear path to extracting services later if independent scaling or team ownership makes that worthwhile.

### What we gave up

Catalog, booking, payment, and OTP cannot be deployed or scaled independently. A process-level failure affects all API modules, and a future split will require explicit inter-service contracts and distributed observability.

## 2. One authoritative booking lifecycle protected by PostgreSQL

### Options considered

- Read a mutable `seats.status` value and then update it in application code.
- Serialize buyers with an in-memory mutex or make Redis the authoritative lock.
- Use Redis as a best-effort guard while PostgreSQL remains authoritative.
- Represent every blocking claim in `bookings` and enforce one active booking per `(showtime_id, seat_label)` with a partial database uniqueness constraint.

### Decision

Use the `bookings` table as the sole authority for whether a showtime seat is held or sold. A booking starts as `HELD`, carries an environment-controlled `expires_at`, and advances through `AWAITING_OTP` and `PAYMENT_PENDING` to `CONFIRMED`. A partial unique index on `(showtime_id, seat_label)` applies to those active statuses. A contender that loses the insert race receives a clean `409 Seat unavailable`. Expired or failed bookings leave the active status set transactionally, with cleanup used only for housekeeping. Redis provides a short token-owned guard to reject obvious simultaneous contenders earlier, but failures fall through to PostgreSQL. Redis also caches immutable catalog data; live availability is not cached.

### Why

The database constraint is shared by every API process and remains correct under genuine concurrent requests. It turns the core invariant—at most one active owner of a showtime seat—into something PostgreSQL enforces rather than something each application instance must remember. The seat map is derived from the seat catalog plus active bookings, so there is no second mutable status that can drift. Redis reduces avoidable hot-seat database work, but an outage, restart, or evicted lock only removes that optimization; it never removes the database invariant.

### What we gave up

Hot seats can still reach the database when Redis is unavailable, and availability reads require joining or querying active booking state. The extra Redis service adds operational complexity without becoming a source of truth. This design is deliberately PostgreSQL-centric and would need a different consistency mechanism if writes were later distributed across databases or regions.

## 3. Payment and OTP are independent gates

### Options considered

- Treat OTP as optional account verification and confirm solely on payment success.
- Run OTP and payment as one sequential request and assume they succeed or fail together.
- Track their outcomes independently and confirm only after both have succeeded, regardless of callback/order timing.

### Decision

Track payment and OTP independently. Starting a charge moves the booking to `PAYMENT_PENDING` and returns immediately; the signed asynchronous gateway callback records payment success or failure. OTP send/verify has its own persisted state and retry/attempt behavior. A booking is confirmed only when the payment has succeeded and OTP has been verified. Either may finish first, and the transition check is safe to repeat.

### Why

The gateway explicitly makes payment callbacks and OTP delivery separate, unreliable flows. Independent persisted state correctly represents partial progress, avoids holding an HTTP request open, and lets idempotent reconciliation handle retries, duplicate callbacks, and the forced callback race.

### What we gave up

The user must complete two gates, so conversion is lower than a payment-only flow and the UI/state machine is more involved. A successful payment followed by an abandoned or expired OTP flow also requires operational refund/reconciliation handling rather than pretending the purchase completed.
