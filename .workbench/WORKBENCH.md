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
| 2a | 05:40 | Lead integration check (isolated copy): `next build` ✓ (52 routes + proxy); vitest 220/221 (1 approvals-audit test broken by in-flight Architect edit). Engine, Studio, Portal round-2 fixes landed. | — |
| 2 | 05:20 | Fix round 2 dispatched to 6 builders: engine (runtime safety, resale, notifications), Architect (grounded extraction, typed deliverables), channels (uploads, SMS/Slack enablement, MCP), studio + portal (design fixes), NEW billing builder (Stripe Connect flat-rate). | pending |
| 2b | 05:45 | Billing (Stripe Connect, flat-rate checkout, portal, webhooks; 25 tests) done. Security critic r2 (server actions, invites, resale, proxy; re-verify). | Foreign-id + role checks across all actions OK; no agency-only data in portal; ReDoS/MCP batch/stranger-email fixed. New: forged Authentication-Results trusted (H), account pre-registration + invite takeover chain (H), open redirect, member→owner invites, custom-domain host serves Studio, SQL in errors. Dispatched to channels, studio, portal, engine. |
| 3a | 06:00 | Design critic r3 (both surfaces, blind vs Linear/Vercel/Stripe). | Studio 7/10, Portal 7.5/10. Today/approve-undo/request-changes at bar. Open: client header collapses on mobile, tenant red on controls, Connect too technical, 'Roster' leaks to client portal, Architect name collisions/copy bugs, mobile truncation, alignment drift. Dispatched. |
| 3b | 06:08 | Production/perf critic at scale (2k orgs, 10k agents, 1.1M runs, 586k deliverables, 500k jobs). | Fresh install + standalone build healthy; portal Today 59–154 ms. Gaps: Studio shell ships whole agency (agents list 40 MB/3.7 s), agency aggregates scan deliverables, portal needs-you seq scan, API pagination scans all tenants, worker doesn't drain in container, queue index mismatch, scheduler throughput, crash-loop jobs never dead-letter, no retention, no instrumentation/CSP. Dispatched: new ops/scale builder + Studio query fixes. |
| 3c | 06:20 | Fix round 3 landed: Portal (brand color only on fills, client-friendly Connect, brand-named MCP server, single confirmations), Studio (mobile header, 2-line titles, consistent widths, attention list clears; paginated lists, 8-agent sidebar, server-side ⌘K, single-org lookups: agents list 223→29 ms, clients 82→7 ms), Architect (no name collisions, article clean-up, offline note out of client questions). | Design critic r4 dispatched to re-score both surfaces. |
