# Product critic r4: AJ's journey (offline model)

**Run (06:57–07:17 UTC):** new agency Tailwind Agents (marcus@tailwindagents.co). Client: Harborview Animal Hospital, industry "Veterinary clinic". The call has five pains (16.5 h/wk; recalls are the biggest at 6 h), one "if you woke up tomorrow" ask (an overdue rabies/DHPP list with a text per owner), and three rules (no surgery/dental prices, "Only Dr. Okafor or I"; never contact the Whitfield family about Biscuit; Elm St. Rescue needs Kayla's sign-off). Uploads: `overdue_patients.csv` (8 rows) and `reminder_policy.docx`. Screens: `.workbench/screens/critic-r4/product-*.png`.

**Would AJ sell this tomorrow? No. 5/10, up from 4.** The dangerous failures are gone: no outbound email from a change request, resale is opt-in, the invite goes out, billing is honest. But nothing useful came out either. With the data uploaded, every deliverable was a filler template, and the Architect still misreads the business.

## Steps
| Step | Result |
|---|---|
| Signup, verify, onboarding | Works |
| Call → proposal (5 s) → edit → hire (7 s) | Mechanics work. Content **broken** (H-A) |
| Agent page after hire: Release now / Preview | Works. Preview shows a placeholder (product-10) |
| Add workflow, upload CSV + DOCX, Run now | Works. Output **broken** (C-1) |
| Invite → accept → Portal | Works. Dev link shown honestly (product-21) |
| Approve + undo | **Partly.** Needs-you Approve works. "Looks good" on a draft has no undo and sends nothing |
| Request changes | **Partly.** Safe (0 approvals, 0 outbound) but the revision is fake (H-3) |
| Ask about a named CSV row | **Partly.** Right row and dates, but "Hi Mochi" (the cat) |
| REST /api/v1 | Works. Answered correctly from the DOCX |
| MCP tools/list, ask_agent | List works. The ask is **hollow** (H-5) |
| Resale | Sharing scope works. The workflow text **leaks** (H-4) |
| Agent email / Settings | Works: domain switch is immediate, "Verified (test mode)" |
| Home / Billing | Works: "$0 MRR, $5,000 not billed · test mode" |

## r3 re-verification
- **C1 (wrong recipient): partly.** "Tomás Herrera about Mochi" found the right row (due 2026-09-14, 49 days). But the email reads "To: Mochi tomas.herrera@…", "Hi Mochi, Thanks for your note", with raw `species: Cat` lines (product-33). I asked for a text and got an email.
- **C2 (change request → outbound): fixed for safety.** The approvals table is empty for the org and the only message is an in-portal notice. The revision itself is fake (H-3).
- **C3 (resale copies KB): fixed for files and memories.** Nothing is ticked by default. With only the DOCX ticked, the customer KB holds exactly `reminder_policy.docx` and 0 memories. Workflow text still leaks (H-4).
- **H4 (Architect misreads): mostly not fixed** (H-A). Fixed: "Add workflow" exists, and "Elm St." survives in the rules.
- **H5 (invite never sent): fixed.** `inviteClientOwner` now calls `emailInvite`. Production returns an error if the email fails. Dev shows a copy link with an honest toast.
- **H6 (filler output): not fixed** (C-1).
- **M7: partly.** Release now and Preview work, and Activity says "lands at 6:00 AM". But the first deliverable is never regenerated after uploads. The one I released at 07:14 still shows "Example A (example)" rows (product-58).
- **M8: partly.** MRR shows "not billed". But the margin column says 100.0% on a not-billed row, approving a draft sends nothing, and approving the placeholder credited "~4.6h saved" (Today says "saved you ~5 hours", product-57).

## Gaps, ranked

**C-1 Deliverables aren't work, even with data on file.** *Vaccine recalls* (output Table) got the CSV and a precise procedure. It returned one generic text ("We have one open item with you") and no table. It claims "List every patient… sorted by days overdue: done from the data on file". It also reports "7 rows" when the file has 8 (product-25). A bulk REST ask returned "Hi {owner first name}, … checking in" (product-60). The released first deliverable is still a placeholder: "What needs Kayla / Example A". Its email draft is "about your surgery or dental work", the never-quote topic. *Fix:* `src/server/llm/offline/compose.ts`: table and text outputs must iterate CSV rows (filter, sort, one draft per row, skip rows that match a rule). The row count is off by one. Regenerate the first deliverable on upload and on Release (`services/engine.ts`).

**H-A The Architect misreads the call.** A vet clinic became a "Crew Scheduling Coordinator". The workflows were "Call-out coverage" and **"Honestly my week"**, taken from "Kayla: And honestly my week is eaten by the phone". It missed vaccine recalls, the largest pain and the explicit ask. It turned "three hours a week, every morning" into "about 21 hours a week". It totals 22.8 h vs 16.5 h ("~29 described on the call"). It asks for a "Crew roster", a HIPAA BAA (for animals), and "access to for the agent". The resale idea is a "call-out desk… 7 PM scramble" (product-05/06). The first deliverable is titled "Call-out coverage: ready to send". Renamed workflows don't reach the deliverable steps. *Fix:* `llm/offline/discovery.ts`: honour `industry` in `pickVertical`, never name a workflow from filler phrases, don't multiply "every morning" by 7, and make the "woke up tomorrow" ask a workflow.

**H-3 The change request "revision" is fake.** The body is identical. It adds "What changed: Worked in your note" plus transcript quotes (product-30). *Fix:* the revise path in `agents/runtime.ts` must regenerate the body against the note, or say what it couldn't do.

**H-4 The resold copy carries the reseller's private names.** The customer's *Vaccine recalls* procedure reads "Skip Biscuit and the Whitfield family entirely. Anything for Elm St. Rescue…". "Kayla" was scrubbed but the names were not. The procedure points to a CSV that was not shared. The customer agent is a "Crew Scheduling Coordinator… (veterinary clinic)" for a pet groomer, with a dangling "5 hours a week by hand today." *Fix:* `resellAgent` (`services/engine.ts`) should strip people and entity names from workflow instructions and regenerate the role for the customer.

**H-5 MCP ask_agent is hollow.** "Which patients are more than 100 days overdue?" returned "Last quarter we had something like 300 patients…" plus my old feedback. The answer is Hazel 125 and Juniper 105. *Fix:* the ask path in `compose.ts` should run row filters over KB tables.

**H-6 The client sees engine junk.** The Team page and REST `/agents` show "Sage finds cover when someone calls out, handles honestly my week… ~29 hours a week described on the call" (product-49). Other leaks:
- "Approve, edit or reject the draft above" appears with no edit or reject control.
- "Anything for Elm St: / Rescue waits…": the runtime step splitter still breaks on "St.".
- "Good evening, priya" at 2 AM, with the name taken from the email.

**M:** "Looks good" approves an email draft immediately: no undo, nothing sent. The domain is "Verified (test mode)" with no DNS records shown. The invite magic-link page doesn't prefill the invited email. "Active agents 2" counts the resold copy.

## Changes to shared data
None in demo orgs. Created: agency `tailwind-agents`, client `harborview-animal-hospital` (plan $5,000, not billed), customer "Lakeside Pet Grooming", a client API key "Priya laptop", agent email domain `agents.tailwindagents.co`.
