# Product critic r1: AJ's journey (offline model)

Live run: agency "Ridgeline AI", client Summit Peak Roofing (Denver roofer). The call covered adjuster chasing, supplements, homeowner texts, and two "never" guardrails. Screens: `.workbench/screens/critic-r1/product-*.png`.

**Verdict:** the flow and UI are at the bar. Signup → hire took about 2 minutes (Architect 0.3s, Hire 8.5s), and the portal is beautiful. But a new client's deliverables aren't work. The seeded ones (product-54) look like $5k/mo. AJ wins the demo and loses the client in week one.

## Gaps, ranked

**C1: Deliverables are not work product.** First run (product-27): a table of the agent's own procedure steps, tagged "Drafted from your materials", next to transcript quotes. No queue, no drafts. Rick's "draft a follow-up email to the State Farm adjuster, #SF-44821" came back as a report with no email (product-32). With a claims CSV added to knowledge, a re-run was identical: zero rows used. *Fix:* `src/server/llm/offline.ts` should emit kind-specific artifacts (email_draft → To/Subject/Body; table → rows from CSV chunks).

**C2: The Architect gets the business wrong and plants false memories.** It says "Summit Peak Roofing (insurance)" and "Marco (owner)". Marco is the signed-in operator (product-10, -15). It made 1 generic workflow instead of 3 asks, dropped both "never" guardrails, and found only "spreadsheets" as a system. Memory can't be edited, and the false fact survives the client's correction. *Fix:* in `agents/architect.ts`, `pickVertical` should trust the industry field, and `extractSpeakers` should parse "Attendees:" and exclude the operator. Add edit/forget to `agents/[agentId]/memory/page.tsx`.

**H3: The resold agent still works for the reseller.** The clone's instructions say "You are Ava… at Summit Peak Roofing", and the customer's portal shows it (product-47). No first deliverable is queued. The resale page counts "Paying customers 1, $900/mo" with no billing. *Fix:* re-template the clone for the customer and queue a first deliverable.

**H4: Most channels can't be switched on.** `connectSmsNumber` has no caller, so the portal says "Ask your provider…" and the agency has no button. Slack depends on env vars (`/api/slack/install` → 404). Email is simulated, yet the client sees "Delivered via Email". *Fix:* add a Channels section to agent Settings in Studio. Stamp `deliveredVia` only on a real send.

**H5: No way to get client data in.** Knowledge takes Link or Text only: no file upload, no Sheets connector, nothing in the portal. Inbound email attachments are only counted (`channels/inbound.ts:467`). *Fix:* CSV/XLSX/PDF upload in Studio and Portal, and ingest email attachments.

**H6: The agency doesn't see an unhappy client.** Rick's "you got our business wrong" created no agency notification. Agency Home still shows "Needs review" (product-48); `changes_requested` appears nowhere in `src/app/a`. *Fix:* a Needs-attention row with the feedback, plus a notification.

**M7: ROI is inflated.** Every Run now or revision adds +5h (`agents/tools/core.ts:102`): 15h "all time" for zero work. "Delivered overnight" lists requests from minutes ago.

**M8: White-label leaks.** Invite and magic-link pages carry the Roster logo. "Powered by Roster" is on by default, against onboarding's "Clients see your name, never ours".

**M9: MCP and REST rough edges.** `ask_agent` returns "Done — …ready in the portal" with no id or body. The server advertises `run_workflow`, but default keys lack the scope. REST wants `text` where MCP uses `message`.

**M10: Wrong time zone.** A Denver client runs on New York time, and nothing asks.

## Journey scorecard
| Step | Result |
|---|---|
| Sign up → client → transcript → proposal → hire | Flow **works**. Content **partly** right |
| 5-part stack + first overnight deliverable | **Partly.** 5 memories (2 false), transcript in knowledge, simulated inbox, "Worker runtime" computer, Portal+Email. Queued for 06:00 ET ✓ |
| Run now → output | Mechanics **work**. Output **broken** |
| Client: invite, Today, approve, request changes, ask | **Works**. Output hollow |
| Client: connect a channel | **Partly** (MCP/API only) |
| API key + MCP + REST | **Works**. Weak replies |
| Resell flow | **Partly** (clone mis-targeted) |
| Agency Home / 2 clicks | **Partly** (misses feedback, hours inflated) |

**$5k/mo?** Not offline. A real model writes fluent drafts but still runs one generic workflow with no claims data and no SMS. Fix C2, H4 and H5 and it becomes credible.
