# Product critic r3: AJ's journey (offline model)

**Run:** new agency, client BrightPath Commercial Cleaning. The call: five pains (~17 h/wk), ask = Monday property-manager reports, rules = no price without Marisol's OK; St. Luke's only via Greg Haines. Uploaded 2 CSVs + a PDF. Screens: `.workbench/screens/critic-r3/product-*.png`. A builder reseed (~06:08) forced a redo (not counted).

## Scorecard
| Step | Result |
|---|---|
| Signup → client → call → proposal → hire | **Works** (2s + 7.6s); content **partly** |
| Stack + overnight deliverable | **Works** (held until 6:00 ET) |
| Upload + Run now | **Partly**: real CSV table, filler drafts |
| Invite, Today, approve/undo | **Works** (product-65) |
| Request changes | **Broken** (C2) |
| Ask the team for a task | **Broken** (C1) |
| Texting / Slack | **Works**, honest |
| API key, MCP, REST | **Works**; hollow replies |
| Resell | Flow works; **leaks data** (C3) |
| Agency Home / Billing | **Works**, honest test mode |

**Would AJ sell this tomorrow? No. 4/10.** Surfaces are at the bar; every client-specific action tonight was wrong or harmful.

## Gaps, ranked

**C1: Wrong recipient.** I asked it to "draft a reply to Lorna Fitch at Bayside". It drafted an email to Renee Calloway, a different client: "Hi there", plus "Our open item" five times. My question about Bayside's score (81 in the CSV) went unanswered. Reproduced twice (product-35, -42). *Fix:* `src/server/llm/offline/compose.ts` ~l.440–465 should match the named person or site to a CSV row. If nothing matches, return no draft.

**C2: A change request turned into an email to St. Luke's.** Marisol's change request caused the agent to request approval to email ghaines@stlukesoutpatient.org with the subject "A price or a quote". The body contained her private note and the internal St. Luke's rule. The address came from the rule memory (product-64, -63). No revision was produced. The approval gate and undo held, but it was one tap from disaster. *Fix:* in `src/server/agents/runtime.ts`, a revision must regenerate the deliverable and never call `send_message`. Never take recipients from rule or memory text.

**C3: Resale copies the reseller's private knowledge.** The Offer dialog says "Your data stays yours". Yet `resellAgent` (`src/server/services/engine.ts:950–967`) copied BrightPath's receivables CSV, its client and property-manager emails, and its internal rate guide into the customer's KB. The customer's agent quotes the template back (product-57a). *Fix:* copy nothing by default. Let the reseller tick which sources to share.

**H4: The Architect misreads the call.** It found 2 of 5 pains and missed the explicit ask. It named a workflow "Last proposal and" and hallucinated "Square" from "square footage". It ignored the Industry field ("medical practice", saved to memory) and cut the rule off at "St.". It estimated 7.3 h vs ~17 h (product-08, -09). Edits don't reach the first-deliverable prompt (product-68). There is no "Add workflow" after hire. *Fix:* in `agents/architect.ts` and `llm/offline/discovery.ts`, use an abbreviation-aware sentence split, trust `industry` in `pickVertical`, and treat "if you woke up tomorrow…" as the first deliverable. Add workflow creation in `agents/[agentId]/workflows`.

**H5: The Studio client invite is never delivered in production.** `inviteClientOwner` (`src/app/a/_actions/org.ts:100–112`) sends no email and returns `link:null` in production. *Fix:* reuse `emailInvite` from `p/[org]/actions.ts`, prefill the email, and always offer a copy-link.

**H6: Offline output is filler.** The drafts are identical "checking in" emails with `{customer first name}`. The "proposal" is just an email. Wrong row counts (product-27). A real key fixes the prose, not C1–C3 or H4–H5.

**M7:** "Before tonight" claims uploads sharpen the first deliverable, but it already ran. It also lists "no AI model was used" for the client (product-12). Activity says "ready" while the deliverable is still held, and AJ can't preview it.
**M8:** Approving an email draft sends nothing. Hours saved stays 0 h. Test-mode plans count as $5,000 MRR at 100% margin with no "not billed" tag.

## Fixed since r1
CSV tables; memory edit; rules captured; file upload; SMS/Slack honesty; truthful "Delivered via"; Home shows change requests; ask_agent ids; no ROI inflation; clone re-addressed; white-label.

## Still open
Deliverables aren't work; Architect misreads (industry); resold agent keeps the reseller's job; texting can't be demoed.
