# Production-readiness and performance critique, round 1

Setup: a snapshot at /tmp/prod, migrated from an empty `roster_prod` database (1.8s), then seeded (1.7s). `next build` exited 0. The production standalone `server.js` ran with an https `APP_URL`. Data volume: 2,006 orgs, 10k agents, 1.1M runs, 2M run_steps, 586k deliverables (one tenant has 100k), 1M messages, 500k jobs and 1M usage_events. Postgres runs with default settings (128MB shared_buffers).

## Page timings (20 sequential requests)
| Page | p50 | p90 | HTML (gzip) |
|---|---|---|---|
| Studio home | 534ms | 604ms | 2.0MB (379KB) |
| Clients | 749ms | 842ms | 9.1MB (599KB) |
| Agents list | **3,729ms** | 3,966ms | **39.9MB** (2.0MB) |
| Agent page | 247ms | 318ms | 2.0MB |
| Billing | 582ms | 687ms | 5.1MB |
| Portal Today, 100k-deliverable tenant | 154ms | 171ms | 157KB |
| Portal Today, typical tenant | 59ms | 68ms | 167KB |
| `GET /api/v1/deliverables`, large tenant | 165ms | – | (`/api/v1/agents`: 6ms) |
| Studio home, 10 concurrent requests | **5.27s** | p95 7.1s | 1.7 requests/s |
| Portal Today, 10 concurrent requests | 1.05s | p95 1.7s | 8.7 requests/s |

## Slowest queries (EXPLAIN ANALYZE)
| Query | Time | Plan |
|---|---|---|
| `getHome` firstDeliveries (`count(*)` grouped by agent) | 228ms (396ms max in the app) | Parallel Seq Scan of the whole 724MB table (97k buffers) |
| `listAgents` stats | 299ms | Seq scan |
| `getHome` changes_requested | 151ms | Seq scan |
| `listDeliverables` (API), page 1 / page 2 | 142 / 168ms | Seq scan of **all tenants** to sort on `date_trunc(created_at)` |
| `countNeedsYou` (runs on every portal page) | 141ms | Seq scan |
| Queue claim with a backlog of 50k jobs | 131ms, sort spills to disk | 0.08ms with the index below |
| `DELETE` one workflow | 351ms | Foreign-key triggers seq-scan deliverables (243ms) and runs (108ms) |

## Critical
**C1. Every Studio page carries the whole agency.** `getShellData` (studio.ts) sends every client and all 10k agents into the sidebar and ⌘K palette. Agent names appear 9,850 times in the home page HTML. `listClients` and `listAgents` have no pagination and return full org rows. Fix: the shell gets counts plus about 20 recent items; the palette searches through a server action (`ilike`, `limit 20`); lists use keyset pages of 50 and select explicit columns.

**C2. Agency-wide aggregates scan the full deliverables table** (`getHome`, `listClients`, `listAgents`). Cost grows with the agency's whole history, so these hit `statement_timeout` at around 10M rows. Fix:
- Add `agents.last_delivered_at` and `delivered_count`, kept up to date in the transaction that inserts a deliverable.
- Add `deliverables.agency_id` with an index on `(agency_id, created_at desc)`.
- `create index on deliverables (org_id, created_at desc) where status='changes_requested';`

## High
- **H1. Portal pages.** `create index concurrently deliverables_review_idx on deliverables (org_id) where needs_review and status in ('new','seen');`
- **H2. API pagination.** Order by `created_at desc, id desc`, use a row cursor `(created_at,id) < ($1,$2)` with microsecond precision, and add an index on `(org_id, created_at desc, id desc)`.
- **H3. Worker shutdown never drains in the shipped container.** SIGTERM to `npm run worker` killed npm and sh; the node process kept processing jobs for more than 20s and never logged "draining". A direct SIGTERM to tsx drained in 500ms. Fix:
  - Dockerfile: `CMD ["node","--conditions=react-server","--import","tsx","src/worker/index.ts"]`, or a bundled `dist`.
  - Compose: `init: true` and `stop_grace_period: 60s`. The worker waits 30s, but Docker's default is 10s.
- **H4. Claim index does not match the sort order.** `create index concurrently jobs_ready2_idx on jobs (queue, priority desc, run_at) where status='queued';` Also move lease reclaim out of the `OR` into its own query.
- **H5. Scheduler is capped at 100 workflows per 15s per worker.** If 100k workflows share a 6 AM cron, the lag is over 2 hours. Fix: loop `schedulerTick` while it returns a full batch.
- **H6. Poison-pill jobs never dead-letter.** The reclaim branch ignores `attempts`, so a job that crashes the worker is retried forever. Fix: add `attempts < max_attempts` and mark the rest dead.
- **H7. No retention anywhere.**
  - Nothing ever deletes from jobs (500k rows, 134MB), webhook_events (whole inbound emails, which are PII), audit_logs, usage_events, or expired sessions and auth_tokens.
  - `rate_limits` is UNLOGGED, created by runtime DDL (needs CREATE privilege) and never pruned. Its keys come from attacker-controlled senders, emails and IPs.
  - Fix: a batched maintenance step in the scheduler: `delete … where id in (select … limit 5000)`, plus `rate_limits where reset_at < now()`. Move the table into a migration.
- **H8. Not observable.**
  - No `instrumentation.ts` or `onRequestError`. Unhandled errors print as unstructured `⨯ TypeError … digest` lines (seen in the logs).
  - No request IDs. Job logs carry `jobId` but not runId or orgId. No queue-depth or lag metric.
  - With `ENCRYPTION_KEY` and `AUTH_SECRET` missing, `/api/health` returned 503 `{"db":"down"}` without logging the cause, while `/login` returned 200. Production does not fail fast. Fix: validate env in `instrumentation.register()`.

## Medium
- **M1. No Content-Security-Policy** (checked with `curl -I`). Add a nonce-based CSP in `proxy.ts`.
- **M2. Indexes for unindexed foreign keys:** `runs(workflow_id)`, `deliverables(workflow_id)`, `approvals(run_id)`, `approvals(agent_id)`, `workflows(org_id)`, `conversations(org_id)`. For the proxy's custom-domain lookup: `organizations(lower(custom_domain))`.
- **M3. Migrations.** The Drizzle migrator has no advisory lock, runs everything in one transaction, and uses a plain `CREATE INDEX`. Future indexes on large tables will block writes.
- **M4. Deploy.**
  - The worker image ships all devDependencies and transpiles TypeScript at boot. It has no healthcheck.
  - `npm start` warns that it is incompatible with standalone output.
  - The README's `docker compose up` with `.env.example` leaves the keys empty, so the stack boots unhealthy.
  - `.env.example` leaves out DB_POOL_MAX, LOG_LEVEL, ROSTER_APP_HOSTS, MCP_ALLOWED_ORIGINS, ATTACHMENT_DOWNLOAD_HOSTS, APPROVAL_TTL_HOURS and ORGO_API_URL. `env.ts` does not check that APP_URL is https.
- **M5. Client bundles.**
  - /login loads 640KB of JS (197KB gzip).
  - zod (115KB, 33KB gzip) reaches agent settings through a value import from `@/server/agents/spec` in `agent-settings.tsx`.
  - react-markdown and micromark (150KB, 45KB gzip) ship because `studio/deliverable-list.tsx` is a client component. Render the Markdown on the server.
  - Every route is dynamic, including `/`.
- **M6. The web tier runs Architect jobs inline.** When a worker lags more than 4s, the web process takes the job through `after()` with a 5-minute lease it never renews, so a worker can process it a second time. Allow this only in development.

## What held up
- Server Actions rejected a foreign `Origin` ("Invalid Server Actions request").
- Every outbound call has a timeout: Anthropic 180s with 2 retries, Stripe 20s, Resend 20s, Twilio 20s, Slack 15s, Orgo 60s.
- In code, cookies are httpOnly, SameSite=Lax, and Secure when APP_URL is https.
- Static assets are served `immutable`.
- The seed refuses to run in production.
- The scheduler and approval-expiry queries use their indexes (9ms and 1ms).
