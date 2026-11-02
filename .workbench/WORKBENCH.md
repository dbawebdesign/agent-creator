# Workbench — live progress (gauntlet loop)

Goal: the platform in docs/SPEC.md. Lead = PM thread. Builders own a slice each; critics are fresh-context agents
that judge the *running product* (screenshots, HTTP, tests), never builder summaries.

## The bar
- **Studio/Portal UI**: Linear, Vercel dashboard, Stripe dashboard — calm, dense-but-airy, one accent, hairline
  borders, instant feedback, ⌘K, nothing on screen that isn't needed now. Critic does blind A/B of our screenshots
  vs. that standard and names the biggest gap.
- **Product**: the transcript's promises — transcript → live agent same day; 5-part stack; proactive overnight
  deliverable; B2B2B resale; flat-rate pricing; meets clients in email/SMS/Slack/API/MCP.
- **Engineering**: OWASP ASVS L2-ish checks, tenant isolation tests, idempotent webhooks, horizontal workers.

## Rounds
| # | When (UTC) | What | Critic verdict / biggest gap |
|---|---|---|---|
| 0 | 04:00 | Scaffold: schema (30 tables), auth/session, access/tenancy, queue, crypto, design tokens, UI primitives | — |
| 1a | 04:30 | Channels & API slice done (65 tests). Security critic launched on channels/API/auth. | pending |
