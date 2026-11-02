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

```bash
docker compose up --build         # Postgres + migrations + web + 2 workers
```

- Web: stateless Next.js standalone server (`Dockerfile` target `web`), scale horizontally behind a load balancer.
- Worker: `Dockerfile` target `worker`, scale horizontally; jobs are claimed with `FOR UPDATE SKIP LOCKED`.
- Required in production: `DATABASE_URL`, `APP_URL` (https), `ENCRYPTION_KEY`, `AUTH_SECRET`.
- Channels: `RESEND_*` (email in/out; point your inbound domain's MX at Resend and the webhook at
  `/api/webhooks/resend`), `TWILIO_*` (webhook `/api/webhooks/twilio`), `SLACK_*` (events URL
  `/api/webhooks/slack`, redirect `/api/slack/oauth/callback`).
- Health: `GET /api/health`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Job worker + scheduler |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle migrations and demo data |
| `npm run typecheck` / `npm test` | TypeScript and Vitest (uses `roster_test`) |
