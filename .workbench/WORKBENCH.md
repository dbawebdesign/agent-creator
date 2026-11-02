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
| 1a | 04:30 | Channels & API slice done (65 tests). Security critic r1 on channels/API/auth. | NOT production bar: prompt injection via inbound email (H), ReDoS in email/html parsing (H), MCP batch rate-limit bypass, no inbound caps, Slack sends ungated, XFF trust, fetch deadline. Fixes dispatched to engine + channels builders; XFF fixed by lead. |
| 1b | 04:50 | Engine slice done (39 tests, 126 total). Engine/Architect critic r1. | Plumbing solid (queue, leases, DST, budget, SSRF OK). Gaps: offline Architect = keyword templates, fails on unseen calls (C); external mail injection/leak (C); approvals partly decorative; email-triggered workflows blind to email; offline output filler; crash duplicates side effects. Split fixes: engine builder (runtime) + new Architect builder. |
| 1c | 04:58 | Channels security fixes done (75 tests). Studio + Portal done. Design critics (studio, portal) + product critic. | Portal: calm but inconsistent widths, brand color hijacks status, one-tap external send w/o undo, hard-coded demo names. Studio: proposal promises vanish after Hire, reading screen claims 'ready' early, ⌘K ranking, one-keypress billing cancel, mobile overflow. Product: flows work mechanically; offline output isn't work; Architect misreads speakers/business; resold agent mis-targeted; SMS/Slack can't be enabled; no data ingestion; agency blind to unhappy clients; no real billing. |
| 2 | 05:20 | Fix round 2 dispatched to 6 builders: engine (runtime safety, resale, notifications), Architect (grounded extraction, typed deliverables), channels (uploads, SMS/Slack enablement, MCP), studio + portal (design fixes), NEW billing builder (Stripe Connect flat-rate). | pending |
