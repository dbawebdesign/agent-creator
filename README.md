# Roster

**Build, staff and resell AI employees that deliver real work.**

Roster is a platform for AI-employee agencies. You run a discovery call with a business, paste the transcript,
and Roster's **Architect** (an agent that builds agents) proposes a vertical AI employee: its job, its
workflows, its schedule, what it needs to know, and the first thing it will deliver overnight. Hire it and the
full stack is live in minutes: memory, a knowledge base, its own email inbox, a computer, and channels
(email, SMS, Slack, REST API, MCP). Your client wakes up to finished work, and can resell the agent to their own
customers under their brand.

- **Studio** (`/a/<agency>`) for the agency: clients, agents, blueprints, flat-rate billing, margin.
- **Portal** (`/p/<org>`) for the business: today's deliveries, approvals, the team, connect channels, resell.
- **Channels**: every agent has its own email address; SMS via Twilio; Slack app; REST API; MCP server for
  Claude Desktop, Claude Code, Codex and any MCP client.

See [`docs/SPEC.md`](docs/SPEC.md) for the product and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
system design, security model and scaling path.

## Quick start (local)

Requirements: Node 22+, Postgres 16 (pgvector optional).

```bash
cp .env.example .env              # works as-is for local dev; no API keys required
npm install
npm run db:migrate
npm run db:seed                   # demo agency, clients, agents and a night of deliverables
npm run dev                       # http://localhost:3000
npm run worker                    # in another terminal: jobs, schedules, channel delivery
```

Demo logins (password `roster-demo`): `aj@northbeam.ai` (agency owner) · `dana@brandlord.co` (client owner) ·
`lena@fourcorners.co` (Brandlord's customer, B2B2B).

Without `ANTHROPIC_API_KEY`, Roster uses a deterministic offline model so every flow works end to end.
Set the key to run on Claude.

## Production

### Docker compose (production-like, local)

```bash
cp .env.example .env
# The two required secrets (web and worker refuse to start without them):
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|; s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 48)|" .env
docker compose up --build         # Postgres + migrate (runs once) + web on :3000 + 2 workers
curl localhost:3000/api/health    # {"ok":true,"config":"ok","db":"up",...}
```

On macOS use `sed -i ''`. `APP_URL=http://localhost:3000` is accepted for local runs; a real deployment needs https.

### Deploying

- **Order:** run migrations, then start/roll web and workers. `node --conditions=react-server dist/migrate.mjs`
  (worker image) or `npm run db:migrate` takes a Postgres advisory lock, so parallel deploys are safe. Pending
  migrations apply in one transaction; then `drizzle/online/*.sql` runs outside a transaction (big-table indexes
  `CREATE INDEX CONCURRENTLY`, batched backfills) without blocking writes. Every step is logged as JSON.
- **Web:** `Dockerfile` target `web`, a stateless Next.js standalone server (`node server.js`); scale horizontally
  behind a load balancer. Without Docker: `npm run build && npm start` (`npm start` runs
  `.next/standalone/server.js` with `public/` and `.next/static` copied next to it).
- **Worker:** `Dockerfile` target `worker`: an esbuild bundle (`npm run build:worker` → `dist/worker.mjs`) on
  production-only `node_modules`. Scale horizontally: jobs are claimed with `FOR UPDATE SKIP LOCKED`, the scheduler
  drains due workflows in SKIP LOCKED batches, and every worker keeps the hourly `maintenance.prune` job scheduled.
  On SIGTERM it stops claiming and drains in-flight jobs for up to 30s: run node directly (not `npm run`), with an
  init process (`init: true`) and a stop grace period of at least 60s. A job whose worker dies is retried when its
  lease expires (5 min) and dead-lettered after `max_attempts`.
- **Required in production:** `DATABASE_URL`, `APP_URL` (https), `ENCRYPTION_KEY` (32 bytes, base64), `AUTH_SECRET`
  (32+ chars). Bad config is fatal at boot (the log names the variable, never its value). `.env.example` lists every
  variable the code reads.
- **Channels:** `RESEND_*` (email in/out; point your inbound domain's MX at Resend and the webhook at
  `/api/webhooks/resend`), `TWILIO_*` (webhook `/api/webhooks/twilio`), `SLACK_*` (events URL
  `/api/webhooks/slack`, redirect `/api/slack/oauth/callback`).
- **Health:** web `GET /api/health` (200, or 503 naming `config` or `db`); worker `node dist/worker-health.mjs`
  (heartbeat file younger than 90s). Both are the images' `HEALTHCHECK`s.
- **Logs:** JSON lines (pino) on stdout with `service` (`roster-web` / `roster-worker` / `roster-migrate`). Server
  errors go through `onRequestError` (route, digest, request id); REST API lines carry `requestId` (`x-request-id`
  is honoured and echoed); job lines carry `jobId`, `type`, `orgId`, `runId`.
- **Retention** (`maintenance.prune`, hourly): finished jobs after 7 days (failed/dead after 30), webhook events
  after 30 days, expired sessions, auth tokens and rate-limit windows. `usage_events` and `audit_logs` are kept;
  when they reach tens of millions of rows, partition them monthly on `created_at` and archive/drop partitions
  older than 13 months (see `src/server/jobs/maintenance.ts`).
- **Security headers:** production responses carry a Content-Security-Policy (`next.config.ts`), HSTS,
  `X-Frame-Options: DENY` and friends.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js (`start` serves the standalone build) |
| `npm run worker` | Job worker + scheduler (dev, via tsx) |
| `npm run build:worker` | Bundle `dist/worker.mjs`, `dist/migrate.mjs`, `dist/worker-health.mjs` (worker image) |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle migrations and demo data |
| `npm run typecheck` / `npm test` | TypeScript and Vitest (uses `roster_test`) |
