# Roster — product spec

Roster is a platform for **AI employee agencies**: operators who build vertical, niche and task-specific AI
employees for businesses, sell them at a flat monthly rate, and let those businesses resell them to their own
customers (B2B2B).

Source concept: Nick Vasilescu (Orgo, YC) on the Conquer Local podcast — "agents building agents", a five-part
agent stack live in 24 hours, flat-rate pricing, proactive delivered work over copilot chat, and B2B2B packaging.

## Who uses it

| Surface | Who | Job to be done |
|---|---|---|
| **Studio** (`/a/[agency]`) | The agency operator (e.g. AJ) and their staff | Turn a discovery call into a live AI employee in minutes; run a book of clients; see delivered value, margin, and what needs attention. |
| **Portal** (`/p/[org]`) | The client business owner and staff (and, for resale, the client's customers) | Wake up to finished work. Review, approve, reply. Ask for new work. Connect the channels they already live in. |
| **Channels** | Everyone, outside the app | Email (each agent has its own inbox), SMS, Slack, REST API, MCP (Claude/Codex/any MCP client). |

## Tenancy

`agency → client → customer`. Memberships on an ancestor grant access to descendants. Every tenant row carries
`org_id`; every query is scoped by it. 404 on no access (never leak existence).

## The agent stack (live within 24 hours)

1. **Memory** — facts, preferences, people, episodes; recalled by relevance, written by the agent.
2. **Knowledge base** — durable documents (text, URLs, files, the discovery transcript itself), chunked and
   searchable (Postgres FTS; pgvector embeddings when configured).
3. **Its own email** — `<handle>@<EMAIL_DOMAIN>`; inbound mail starts or continues conversations.
4. **A computer/runtime** — pluggable provider (Orgo cloud computers); tools run in the worker otherwise.
5. **Channels** — meets the client where they are: email, SMS, Slack, portal, API, MCP.

## The agent that builds agents (the Architect)

Input: a discovery-call transcript (+ client name/industry). Output: an `AgentSpec` (see
`src/server/agents/spec.ts`): name, role, instructions, voice, 1–12 workflows (each with the "itch" it solves,
procedure, trigger, output kind, delivery channels, hours saved), knowledge needs, seed memories, approval rules,
a **first overnight deliverable**, a resale (B2B2B) idea, and open questions.

The operator reviews and edits the proposal, then **Hire** provisions everything: agent row, workflows with
schedules, seed memories, transcript into the knowledge base, inbox handle, computer (if configured), and queues
the first overnight deliverable.

## Proactive by default

The product's center of gravity is **delivered work**, not chat. Workflows run on schedules or events, produce
deliverables (reports, documents, tables, email drafts), and deliver them to the portal and the client's channels.
Risky actions (sending external email, spending money) wait for approval. The portal home is "what your team
did for you", not a chat box.

## Business model

Flat-rate plans (default $5,000/mo, no setup fee, no token billing) that the agency sells to clients; clients
can define their own plans to resell agents to customers. Internal usage/cost metering is visible only to the
agency (margin view).

## Non-functional

- Production: Next.js (App Router) + Postgres; stateless web tier; horizontally scalable workers with a
  Postgres SKIP LOCKED queue; idempotent webhooks; migrations with drizzle.
- Security: scrypt passwords, opaque DB sessions (httpOnly, SameSite=Lax), hashed API keys with scopes,
  AES-256-GCM secrets at rest, webhook signature verification (Svix/Resend, Twilio, Slack), SSRF-guarded
  fetch tool, rate limiting, audit log, strict tenant scoping, security headers.
- Works with zero config: without `ANTHROPIC_API_KEY` an offline deterministic model powers the Architect and
  runtime so the whole product can be demoed and tested.
