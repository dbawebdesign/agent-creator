# Product critic r5: insurance agency, offline model

**Run (07:55–08:08 UTC):** new agency Keel Agents (nora@keelagents.co), client Ridgeline Insurance Group, industry "Independent insurance agency".
- **The call:** renewals (5 h/wk), COIs (5 h/wk), claims status (3 h/wk), commission reconciliation (6 h/month).
- **The ask:** "every policy renewing in the next 30 days that hasn't been quoted yet, soonest first, a renewal email drafted to each client".
- **Rules:** no premiums or "bound"; never contact Castillo Builders; "for Dr. Okoro's dental practice, only ever talk to Dr. Okoro".
- **Data:** `renewals.csv`, 18 rows. The correct answer is **9 rows**: 10 "not quoted" rows renew 11-02..12-02, minus Castillo (Summit 11-03 … Delgado 11-28).

Screens: `.workbench/screens/critic-r5/product-*.png`.

**Would AJ sell this tomorrow? No. 5/10, the same as r4.** Safety and resale are now solid. But none of the four paths that touch the CSV produced the list Linda asked for. Two of them show the client debug text.

## Steps
| Step | Result |
|---|---|
| Signup, onboarding, verify | Works. First signup submit bounced back to /signup once, then the account existed |
| Call → proposal (5 s) → hire (7 s) | Mechanics work. Content **broken** (H-2) |
| Agent page after hire: held deliverable, Preview, Release now | Mechanics work. The content after upload is **broken** (C-2, product-06) |
| Upload CSV | Works (4 passages, Ready) |
| Run now (after I rewrote the procedure myself) | **Broken** (C-1) |
| Invite → accept → Portal | Works. The email is not prefilled on the sign-in step |
| Portal ask naming Erin Walsh | **Partly.** Right row and facts, wrong greeting (H-3) |
| Request changes | **Partly.** It re-runs, but the result is wrong. Safe: 0 approvals, only in-portal notices |
| MCP initialize, tools/list (5 tools), ask_agent | List works. The ask is **partly** right (r4 H-5) |
| Resale | **Works.** Nothing ticked by default, and the copy is clean |

## r4 top 5, re-verified
- **C-1 Deliverables aren't work: not fixed.** See C-1 and C-2 below.
- **H-A Architect misreads: not fixed.** Four pains became **one** workflow, "Coi follow-up". It carries the *claims* quote, the "~5 hours", an adjuster-chasing procedure and the role "Adjuster Follow-up Coordinator". It missed renewals (the biggest pain and the explicit ask), reconciliation and COIs-as-COIs. The Dr. Okoro rule was dropped. The Castillo rule was cut to "Never contact Castillo Builders about anything." The text uses lowercase "coi".
- **H-3 Fake revision: partly fixed.** It now re-filters. It says "1 → 0 rows; left out what you named; **re-sorted as asked**", but the sort failed. It dropped my "status not quoted" and kept a stale "days overdue ≥ 5" filter, so the result is 0 rows (product-18).
- **H-4 Resale leaks: fixed.** The customer procedure has no Castillo, Okoro, Linda or Jamal. "renewals.csv" became "the team's file". The customer has 0 KB, 0 memories and 0 deliverables.
- **H-5 MCP hollow: partly fixed.** It now answers from the CSV: "14 rows… renewal date next 30 days". That count is right for the date filter alone. It ignored "still not quoted" (the answer is 10), so Castillo and three quoted rows appear. It is not sorted soonest first. It prints "Luis Delgado — -26 days" and truncates with "and 2 more".

## Gaps, ranked

**C-1 Run now ignores the procedure.** I rewrote the procedure myself: "renewal_date within the next 30 days and status 'not quoted', soonest first, skip Castillo". The run still produced the stale follow-up queue, with one row: Blue Heron Books (*lapsed*, renewal 10-25). The email says "I'm following up on BOP — lapsed, 8 days since we last heard back… where it stands". It is not a renewal email, and it goes to a lapsed client. The run before my edit titled it "Claim BOP: next steps". After the edit, the "Needs your decision" rule check lost the never-quote rule. *Fix:* in `llm/offline/compose.ts`, the email_draft/follow-up path must run `planRows` against the workflow's instructions, not a fixed "days since ≥ 5" queue.

**C-2 The row-plan parser misreads plain asks** (`planRows`, `llm/offline/tablework.ts`). The first deliverable was regenerated after the upload and released to the client. It reads "0 rows (status is quoted and renewal date tomorrow)". Three parser faults cause this:
- The date window takes the first regex hit (l.369), so "woke up **tomorrow**" beats "next 30 days".
- Negation is dropped: "hasn't been quoted" becomes "status is quoted".
- "soonest first" captures an empty column (l.415), giving "sort by “” — no column called that".

**H-1 The client sees engine text.** The released first deliverable and the revision both show this in the client portal (product-17/18): "Couldn't apply: sort by “” — no column called that (columns: client_name, contact_name, email, phone…). The rest is applied." The Team page and MCP `list_agents` show "Felix handles coi follow-up… about 4 of the ~5 hours a week described on the call" (product-20).

**H-2 The Architect collapses multi-pain calls** (`llm/offline/discovery.ts`). It makes one workflow per call instead of one per pain. It attaches the wrong quote and hours to it, and never turns the explicit ask into a workflow. The ask appears only in the deliverable description, under the wrong title "Coi follow-up: ready to send". A rule phrased "only ever talk to Dr. Okoro himself, never the front desk" is not captured. The proposal also asks for an "Export of open cois from Applied Epic" and "How many touches should an adjuster get".

**H-3 Named recipient, wrong voice** (compose named-row draft). The data is right: GL, Philadelphia, renews 2026-12-01, status quoted. But the draft has "To: Maple Leaf Daycare <erin@…>", "Hi Maple," and third-person text: "Erin Walsh's general liability is due Dec 1. Reply with a day and time that works and we'll get it booked." That is an appointment template, used here for a renewal. The greeting should use `contact_name`, not the first word of `client_name`.

**M:**
- "Good evening, linda" at 3 AM EST, with the name lowercased from the email.
- The invite sign-in email is not prefilled.
- "Offer teammate" gives no toast.
- Hydration-mismatch page error on `/p/[org]/d/[id]`.
- "Felix wants your review" shows twice for the same title.
- The proposal had no visible "Add workflow" button.

## Changes to shared data
None in demo orgs. I created:
- agency `keel-agents` (nora@keelagents.co)
- client `ridgeline-insurance-group` (linda@ridgelineins.example.com, owner)
- the API key "Linda laptop"
- resale customer "Harbor Point Insurance", with a Felix copy
- an edited procedure on Ridgeline's workflow
- the released first deliverable
