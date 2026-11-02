# Product critic r6: roofing contractor, offline model

**Run (08:21–08:31 UTC):** new agency Slateline Agents (tess@slatelineagents.co / critic-r6-pass), client Ironclad Roofing & Exteriors ("Residential roofing contractor").
- **The call:** estimate follow-up (6 h/wk), insurance supplements (4 h/wk), crew scheduling (5 h/wk), warranty registrations (3 h/wk). The pains were introduced as "First, … Second, … Third, … Fourth, …".
- **The ask:** every estimate over $10,000 left unsigned for more than 7 days, biggest first, with a follow-up email to each homeowner by first name.
- **Rules:** never mention financing or put a price in writing; never contact the Hendersons on Maple Court, because Rick Alvarez handles them.
- **Data:** `estimates.csv`, 20 rows. My hand count gives **8 rows**: status sent, over $10k, sent before 10-26, Henderson excluded. In order: Novak, Kowalski, O'Brien, Patel, Lindqvist, Whitfield, Ito, Albright.

Screens: `.workbench/screens/critic-r6/product-*.png`.

**Would AJ sell this tomorrow? No. 5/10, the same as r5.** Questions the client asks are now answered correctly. But the first deliverable is wrong, and it drafts an email to the person the client said never to contact. The revision does nothing, and the workflow names read as broken.

## Steps
| Step | Result |
|---|---|
| Signup, onboarding, verify email | Works |
| Call → proposal (5 s) | **Partly.** 4 workflows, each with the right quote and hours, and both rules kept whole. The names are wrong (G-2) |
| Hire (7 s), upload CSV | Works (4 passages, Ready) |
| Release now on first deliverable | Mechanics work. Content **wrong**: 15 rows instead of 8, and 14 drafts including Henderson (G-1) |
| Portal ask: unsigned full replacements, largest first | **Right.** 8/8 rows in the right order, but no amounts even though I asked for them |
| MCP ask_agent: status sent, over $15k, oldest first | **Right.** 8/8 rows in the right order, again without the amounts I asked for |
| Request changes: "leave out signed and declined" | **Broken.** It says "Nothing changed: '…' isn't in the draft." Brooks, Harper and Fischer are still listed. Safe: 0 approvals, nothing sent |
| Workflow "Run now" (First) | **Broken.** A template with no rows: "about your each one", plus a table of "Example A / Example B" |

## r5 top 5, re-verified
- **C-1 Run now ignores the data: not fixed, and worse.** The default procedure reads "List everything due for first from JobNimbus". The run output uses no CSV rows at all.
- **C-2 Row-plan parser: partly fixed.** "tomorrow" no longer takes over the date window, and the sort works. It still ignores "unsigned" (the status column). It also says "I couldn't find a number in the file for 'more than 7 days'" even though `sent_date` exists. The summary repeats a clause: "amount over $10000 and amount over $10000".
- **H-1 The client sees engine text: not fixed.** The portal shows these lines:
  - "Not addressed yet: … Name one person in your request, or run this as a workflow"
  - "1 more rows … I draft the first 14 per run"
  - "the status says the policy or account is closed" (insurance wording, for a roofer)
  - "Coming up: Fourth / Third / First"
- **H-2 The Architect collapses pains: count fixed, naming broken** (G-2).
- **H-3 Wrong voice: partly fixed.** The greeting now uses `contact_name` ("Hi Petra"). The body is still the appointment template: "metal roof is coming up. Reply with a day and time … get it booked." That is not an estimate follow-up.
- **r4 H-5 MCP: fixed** for filter and sort. It drops the columns I asked for.

## New gaps, ranked
**G-1 It drafts to a never-contact person.** The Henderson row (homeowner "Henderson residence", address "22 Maple Court") is in the table and gets a drafted email. This happens in the first deliverable and again in the revision, with no flag. Meanwhile the "First" run output carries the stamp "Checked against your rules". Signed customers (Brooks, Harper) also get "we'll get it booked" drafts. *Fix:* match the do-not-contact rule against row values (name or address), and drop or flag those rows. Also apply the status implied by "unsigned" or "still at status sent".

**G-2 Ordinal words become workflow names.** "First, estimate follow-up" gave:
- workflows named "First", "Third" and "Fourth"
- the role "Roofing First Coordinator"
- knowledge asks such as "How first is done today"
- "Walk us through one example of fourth"

These names reach the client portal, the Team page and MCP `list_agents`. Rick (named in a rule) is missing from People.

**G-3 The revision is a no-op.** A plain status exclusion is read as text to delete. The result is an honest no-op, but the client asked for one change and gets nothing.

**G-4 Answers leave out requested columns.** Both the Portal answer and the MCP answer list names only, though both questions asked for amounts.

Not checked (time): resale, invite email prefill (still empty), mobile, dark mode.

## Changes to shared data
None in demo orgs. I created:
- agency `slateline-agents`
- client `ironclad-roofing-exteriors` (gina@ironcladroofing.example.com, owner)
- the API key "Gina laptop"

I also released the first deliverable, requested one change and ran "First" once.
