# Architecture

```
                ┌──────────────────────────── Next.js (stateless, N replicas) ───────────────────────────┐
 Browser ──────▶│ Studio /a/[agency]   Portal /p/[org]   proxy.ts (custom domains → portal)              │
 Claude/Codex ─▶│ /api/mcp (JSON-RPC, API-key auth)      /api/v1/* (REST, API-key auth, scoped)          │
 Resend/Twilio ▶│ /api/webhooks/{resend,twilio,slack}  → verify signature → webhook_events → enqueue      │
 Slack ────────▶│ /api/slack/{install,oauth/callback}                                                     │
                └───────────────┬─────────────────────────────────────────────────────────────────────────┘
                                │ SQL (pooled)
                        ┌───────▼────────┐        ┌──────────────── Worker (M replicas) ───────────────────┐
                        │  Postgres 16   │◀──────▶│ claim jobs (FOR UPDATE SKIP LOCKED, leases, backoff)    │
                        │  + pgvector    │        │ scheduler tick: due workflows → agent.run (idempotent) │
                        │  jobs queue    │        │ agent.run → runtime tool loop → deliverables/messages  │
                        └────────────────┘        │ channel.deliver → Resend / Twilio / Slack              │
                                                  │ discovery.analyze → Architect → AgentSpec              │
                                                  └───────────────┬────────────────────────────────────────┘
                                                                  │
                                       Anthropic (Claude) · Orgo computers · Voyage embeddings (optional)
```

## Key decisions

- **One Postgres to start.** Tenancy, queue, rate limits, FTS and vectors all live in Postgres. Zero extra infra
  on day one; each piece has a clean seam to move out (queue → SQS/Redis Streams, vectors → dedicated store,
  rate limits → Redis) when a metric says so.
- **Stateless web, horizontally scaled workers.** No in-memory state in the web tier (sessions are DB rows; the
  per-request `cache()` is request-scoped). Workers are safe to run in parallel: jobs are claimed with
  `SKIP LOCKED` under a lease, retried with exponential backoff + jitter, dead-lettered after `max_attempts`,
  and deduplicated by idempotency keys (a unique partial index over queued/running jobs).
- **Agents are data, not deployments.** An agent is a row (instructions, config, workflows, memory, knowledge);
  provisioning a new AI employee is a transaction plus a few jobs, which is why "the agent that builds agents"
  can do it in seconds after a discovery call.
- **Proactive first.** Workflows (cron in the org's timezone, or events like `email.received`) drive runs that
  produce deliverables. Chat is a channel, not the product.
- **Offline model.** Without `ANTHROPIC_API_KEY`, a deterministic provider drives the same tool loop so the
  product can be demoed and tested end to end with no keys.

## Tenancy & access

`organizations` form a tree (agency → client → customer) with `agency_id` denormalized for fast scoping.
`resolveAccess(user, orgId)` walks the (≤3-deep) ancestor chain; the nearest membership wins. Pages and
actions call `requireOrg(slug, minRole)`; API/MCP calls resolve the org from the API key. Every tenant query is
filtered by `org_id`; missing access is a 404.

## Scaling path (zero → millions)

| Stage | Change |
|---|---|
| 0–1k agents | Single Postgres (managed), 2 web + 2 worker replicas. |
| 1k–50k agents | Read replica for portal reads; PgBouncer (transaction mode); raise worker replicas; HNSW index on `knowledge_chunks.embedding`. |
| 50k+ agents / 10M+ runs | Partition `runs`, `run_steps`, `messages`, `usage_events`, `audit_logs` by month; move queue to SQS/Redis Streams behind `queue.ts`; per-tenant concurrency caps; object storage for large deliverable payloads. |
| Enterprise | Dedicated database per large tenant (the `agency_id` column is the shard key), SSO (SAML/OIDC) at the session layer, regional deployments. |

## Security model (summary)

- Passwords: scrypt (N=2^14, r=8, p=1), timing-uniform login. Sessions: 256-bit opaque tokens, only SHA-256
  stored, httpOnly + SameSite=Lax + Secure (https), 30-day sliding expiry.
- API keys: `rk_live_…`, only SHA-256 stored, scopes, optional agent pinning, revocation, expiry, rate limits.
- Secrets at rest: AES-256-GCM with `ENCRYPTION_KEY`; app refuses to boot in production without keys.
- Webhooks: Svix (Resend), Twilio and Slack signatures verified with timing-safe compares and replay windows;
  inbound events stored idempotently before processing.
- Agent tools: `http_fetch` is SSRF-guarded (https only, DNS-resolved private/link-local/metadata ranges blocked,
  size and time limits). Risky actions (external email, spend) require human approval.
- Security headers (HSTS, nosniff, frame deny, referrer policy), audit log for sensitive actions.
- Clients never see model names, tokens or cost; that data is agency-only.
