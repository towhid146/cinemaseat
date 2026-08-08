# CinemaSeat load tests

Run these from outside the application host. All scenarios require an available
seeded showtime and seat; choose a fresh seat for each run.

```bash
k6 run -e BASE_URL=https://cinema.example.com -e SHOWTIME_ID=1 -e SEAT_LABEL=A1 load-tests/scenario-a-contention.js

# The API stack must use the same short HOLD_TTL_SECONDS value.
k6 run -e BASE_URL=https://cinema.example.com -e SHOWTIME_ID=1 -e SEAT_LABEL=A2 -e HOLD_TTL_SECONDS=5 load-tests/scenario-b-expiry.js

# Bonus breakpoint run. Supply several seeded seat labels to spread write load.
k6 run -e BASE_URL=https://cinema.example.com -e SHOWTIME_ID=1 -e SEAT_LABELS=A3,A4,A5,A6 load-tests/scenario-c-breakpoint.js
```

Scenario A uses exactly 100 total iterations with 100 preallocated VUs. Its
thresholds require 1 HTTP 201, 99 HTTP 409 responses, no unexpected response,
and a final seat map showing the target as `HELD`. It writes
`scenario-a-summary.json`, including an explicit oversell count.

Scenario B records the first hold, waits for the configured TTL plus a small
grace period, confirms `AVAILABLE`, and rebooks with a different user. It writes
`scenario-b-summary.json` and logs the observed timeline.

Scenario C intentionally has no hard latency threshold: use its per-operation
p95 latency and error-rate output to identify the first stage where latency
bends upward or errors begin. Correlate that timestamp with API, Postgres
connection-pool, CPU, and memory metrics before documenting the bottleneck.

