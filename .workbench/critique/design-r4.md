# Design critique, round 4

Evidence: `.workbench/screens/critic-r4/`
- `studio/`, `portal/`: every route in light and dark, on desktop (1440) and mobile (390).
- `studio-full/`, `portal-full/`: full-page captures.
- `flow/`: interactions. These cover ⌘K, validation, a real hire (Ezra for Harbor & Pine Law), approve then Undo, request changes, the avatar menu, the mobile drawer and mobile ⌘K.

Side effects on the shared DB:
- Ezra was hired and then archived through the UI. Ezra's `deliverable.release` job is still queued for 11:00 UTC (`f7a5826a…` or a sibling; the org is Harbor & Pine). The lead may want to cancel it.
- Approve was undone within the 5s window. The approval is still `pending`.
- Viewing "Four Corners — November social pack" changed its status from `new` to `seen`.

**Studio: 7.5/10** (r3: 7). Mobile is fixed: the client header, 2-line titles and billing rows all work. ⌘K is quick and well grouped. Two gaps remain:
- Just after the hire, the agent page breaks its promise.
- One "provisioning" agent has been spinning for 25+ minutes with no way out.

**Portal: 8/10** (r3: 7.5). In light mode the controls are now ink, Connect speaks the client's language, and the review loop is at the bar. Remaining gaps:
- Engineering state ("test mode", `agents.roster.local`) still reaches the client.
- In dark mode, a switch that is on looks disabled.
- There is no ⌘K.
- Page widths jump between tabs.

## Now at the bar
- **Portal, review loop.** The deliverable reading view has a meta rail and a sticky "Approve & send" bar. Approve shows "Sending to lena@… in a few seconds… [Undo]", and Undo really restores the state. Request changes opens inline with a single confirmation. All of this holds on mobile, where the bar sits above the tab bar (`flow/p03`, `p10`).
- **Portal, Today.** It opens with "While you were away… three things, ~8 hours". The "Needs your OK" item comes first, and the cards are calm (`portal/p_brandlord-light-desktop`).
- **Portal, Connect.** It is in plain language: "Ask Northbeam to give Maya and Theo a texting number". The copy button sits beside the MCP command, not on top of it.
- **Portal, light-mode controls.** Toggles, the selected card and the radio are ink. Red is kept for the brand mark and the primary CTA.
- **Studio, Home.** The KPI strip, the dense "Delivered overnight" list and the "Needs attention" rail are Linear-grade in both themes.
- **Studio, ⌘K.** It is grouped into Actions / Go to / Clients / Agents. It has a key-hint footer, ranks results correctly and searches the server. `C` opens New agent.
- **Studio, lists.** The agents and clients tables, the client page header on mobile, the stacked billing rows with margin % on mobile, and the fade on the agent tabs on mobile.
- **Studio, other flows.** The provisioning screen redirects to the agent by itself. Archive asks for confirmation in a named dialog ("Archive Ezra?").

## Findings (ranked)

### Critical

**C1. After the hire, the agent page shows "No deliverables yet" while the first deliverable sits finished in the queue.**
- Route: `/a/northbeam/agents/<new>`, desktop and mobile, both themes.
- Screens: `flow/s12-hired.png`, `flow/a_northbeam_agents_c6f559bb…-dark-desktop.png`.
- What the user sees: the proposal promised "Receivables snapshot. Lands in Harbor & Pine Law's portal tomorrow morning". The banner says "the first deliverable is on its way". Under "First deliverable" there is a generic dashed empty state: "Finished work shows up here as Ezra delivers it". After a reload the banner is gone too, so nothing on the page remembers the promise.
- Root cause: the deliverable already exists in the payload of the `deliverable.release` job, which is held until 11:00 UTC.
- This is a regression from r3, which listed it as fixed.
- Fix: when a release job is pending for the agent, render a real card in place of the empty state:
  - The title and summary from the payload.
  - "Ready · lands in the portal at 6:00 AM ET" with a small clock.
  - A "Preview" link (Studio only).
  - "Release now" as a secondary action.
- Never show the empty state while a first deliverable is queued.

### High

**H1. The stuck provisioning state has no exit.**
- Route: `/a/northbeam/agents/39b2…` (Iris), and the "Needs attention" rail on Home. Desktop, light.
- Screen: `studio/a_northbeam_agents_39b2a68f…-light-desktop.png`.
- What the user sees: "Setting up Iris. This page updates on its own. It usually takes under a minute." Memory and Knowledge have spun for 25+ minutes. Home lists "Iris is provisioning · 20 min" as needing attention but offers nothing to do. The setup checklist and "The stack" on the same page list the same five rows.
- At the bar (Vercel deploys): once a run passes about 3× the expected time, stop the spinners and say "Setup stalled at Memory". Show the error line and give a primary "Retry setup" button. Home should say "Iris's setup stalled. Retry".
- Hide "The stack" until setup is done.

**H2. The hero output contradicts the transcript.**
- Route: `/a/northbeam/agents/new` (proposal), desktop.
- Screens: `flow/s09-proposal.png`, `flow/s10-proposal-full.png`.
- The call was explicit. It named a Monday aging report with drafted reminders, a Friday one-page cash summary for Mark, and routing client replies to the right person. The proposal has one workflow, "Monthly on the 1st at 6:00 AM".
- One "Confirm with" question asks "Who … should receive the morning deliverables?" The call already answered that: Mark.
- The disclaimer "Drafted offline… (no AI model was used)" excuses this in prose. But this is the screen AJ demos.
- Fix, in `architect.ts`: pull out every "every <weekday>" and "Monday/Friday" cue and turn each into its own workflow with that weekday schedule. Check each open question against the transcript and drop the ones it answers.
- Polish on the same screen:
  - The name input leaves a wide gap: "Ezra · Billing Coordinator". Make the input auto-size.
  - "Confirm with Harbor" uses only the first word of the client name. Use the full name or the speaker ("Rebecca").
  - "13 h saved / run" has loose spacing inside the field.
  - The schedule chip is the only chip tinted with the accent. Make it neutral like the others.

**H3. Engineering state and the platform domain leak into every client surface.**
- Routes: Portal Today, deliverable, Team, agent, Connect, Resell, Settings. Both themes.
- Screens: `portal/p_brandlord-light-desktop`, `portal/p_brandlord_d_ca75…-dark-desktop`, `portal/p_brandlord_resell-light-desktop`, `portal/p_brandlord_settings-light-desktop`, `portal/p_brandlord_connect-light-desktop`.
- "Test mode" appears in four forms:
  - "Slack (test mode)" and "Email (test mode)" on the cards.
  - "Email (test mode)" in the deliverable rail.
  - A "Test mode" pill on Resell › Payouts and Settings › Your plan.
  - "Stripe isn't connected yet…".
- Every agent address is `maya@agents.roster.local`. That leaks the "roster" name and shows a `.local` dev domain, which breaks Settings' own promise: "Clients see your brand — not ours — … in email".
- Fix:
  - Portal never says "test mode". List only the channels that actually delivered, so "Portal" alone here.
  - Replace the plan and payout notices with one neutral line, "Billing is handled by Northbeam", or hide them until billing is connected.
  - Studio gets a single agency-only "Test mode" banner.
  - Addresses should use a per-agency sending domain; in the seed, use a real-looking one. Never render `.local` in the portal.
- Code: `components/portal/icons.tsx:73`, `review-panel.tsx:84-95`, `billing-flags.tsx`.

**H4. On mobile, the workflow rows hide the information that matters.**
- Route: `/a/northbeam/agents/<id>/workflows`, mobile, both themes.
- Screen: `studio/…_workflows-dark-mobile.png`.
- What the user sees: titles cut to "Weekly social asset…" and "Friday client status …", and the schedule cut to "Mondays at 6:00 AM · …", so the next run and the destination are lost. Three controls (play, chevron, switch) take about half the row width.
- Fix, under `max-sm`:
  - Allow the title to wrap to 2 lines and put the schedule on its own line.
  - Move "Run now" and "Edit" into one "…" menu and keep only the switch inline.
- On desktop, show "Run now" on hover only, as Linear does. Three always-visible controls per row are noisy.

**H5. In dark mode, a switch that is on looks disabled.**
- Route: Portal Settings and the agent page ("What Maya does"), dark, desktop and mobile.
- Screen: `portal/p_brandlord_settings-dark-desktop.png`.
- Cause: `portal.css:92,94` sets the checked track to `--ink-3` (#a1a1aa) with a white thumb. That is mid-grey on near-black, so Email "on" reads as greyed out next to the "off" switches.
- Fix: the checked state in dark should use an `--ink` (#f4f4f5) track with a `--canvas` thumb. That keeps the light-mode logic (high contrast = on).

### Medium

**M1. The Portal has no ⌘K.**
- Route: `/p/brandlord/*`, desktop.
- Screen: `flow/p01-cmdk.png`. Ctrl+K does nothing.
- The bar, and the Studio, have it. Dana's most common jumps are "the thing Maya sent", "ask Theo…" and Settings.
- Fix: mount the shared `CommandPalette` in `components/portal/shell.tsx` with these groups:
  - Needs your OK
  - Recent deliverables
  - Teammates
  - An "Ask Maya…" action that pre-fills the composer
  - Pages

**M2. Studio ⌘K can't find work.**
- Route: Studio ⌘K, desktop.
- Screen: `flow/s03-cmdk-approve.png`.
- What the user sees: typing "approve" gives "No results." while an approval is waiting on Home. Deliverable titles ("Quote deck…") and workflows aren't indexed either.
- Fix:
  - Show a "Needs attention" group at the top when the query is empty.
  - Index deliverable titles, approvals and workflow names in the server search.
  - Add verbs such as "Review: Send the weekly status email…".
  - On touch devices, hide the "↑↓ to move ↵ to open esc" footer (`flow/s22-m-cmdk.png`).

**M3. Portal page width jumps between tabs, and the right third of Today is dead.**
- Route: Portal Today, Requests and Connect (a 720px column in a 1040 frame) against Team, agent, Resell and Settings (1040). Desktop.
- Screens: `portal/p_brandlord-light-desktop` vs `portal/p_brandlord_team-light-desktop`.
- What the user sees: switching tabs makes the content width snap, and Today leaves about 270px empty on the right at 1440.
- At the bar (the Stripe home): use a right rail on Today, "Coming up tonight", listing the next run per teammate (data already shown on the agent page as "Next today at 6:00 AM"). This also sells the product's proactive side.
- Requests detail should get the same meta rail as the deliverable page. Keep 720 only for pure reading.

**M4. The Studio sidebar roster truncates, duplicates and reshuffles.**
- Route: every Studio page, desktop and the mobile drawer.
- Screens: `studio/a_northbeam-light-desktop`, `flow/s21-m-drawer.png`, `flow/s12-hired.png`.
- What the user sees: 5 of 7 client labels are cut ("Four Corners …", "Coastal Prom…", "Harbor & Pine…"). There are two "Maya" rows. The order changes between visits: Theo was 3rd, then 7th after the hire. That breaks spatial memory.
- Fix: group by client, with the client as a quiet sub-heading and its agents beneath, or show only agent names with the client in a tooltip. Use a stable alphabetical or pinned order.

**M5. Agent settings: the danger zone sits in the middle, and the copy is written for developers.**
- Route: `/a/northbeam/agents/<id>/settings`, desktop.
- Screens: `studio-full/…_settings-light-desktop.png`, `flow/s15-archive-confirm.png`.
- What the user sees: the "Lifecycle" section, with a red "Archive", sits above "Channels". The Channels copy says "Point its incoming-message webhook at /api/webhooks/twilio" and "Not set up on this server". "Save changes" is a filled button even when nothing has changed.
- Fix:
  - Order the sections Profile → Approvals → Channels → Danger zone, last.
  - Put the webhook details behind a "Setup details" disclosure.
  - Disable Save until the form is dirty, and show "Saved" inline.

**M6. Resell says everything twice.**
- Route: `/p/brandlord/resell`, desktop and mobile.
- Screens: `portal/p_brandlord_resell-light-desktop`, `…-dark-mobile`.
- What the user sees:
  - The hero says "Billing isn't connected yet…" and the Payouts card right below repeats it.
  - There are three create CTAs whose meanings overlap: "Add a customer", "Offer a teammate" and "New plan".
  - The stats "Subscribed customers 1 / Teammates resold 1" repeat the one-row list below them. Their digits render in the mono face while "$750" is in sans.
  - The single plan card is half width and looks orphaned.
- Fix:
  - Keep one primary, "Add a customer". Its flow picks the teammate and price, with "New plan" inside it.
  - Fold the payout notice into the hero subline.
  - Drop the stat pair until there are 3 or more customers.
  - Use sans tabular figures.

**M7. Status is shown twice, and differently on each list.**
- Routes: agent header, client page agent cards, agents list, clients list. Desktop and mobile.
- Screens: `studio/…_18c8…-light-desktop`, `studio/a_northbeam_clients_brandlord-light-mobile`, `studio/a_northbeam_agents-light-desktop`.
- What the user sees:
  - A green dot on the avatar and "● Active" next to it.
  - "Active" repeated on 5 of 6 agent rows.
  - Clients use a filled pill while agents use a bare dot.
- At the bar (Linear): show only the exceptions (Paused, Provisioning, Stalled) and use one status component everywhere.

### Low

**L1. Mobile polish.**
- Screens: `studio-full/a_northbeam-light-mobile.png`, `flow/s21b-m-drawer-after-esc.png`, `portal/p_brandlord-dark-mobile.png`.
- Studio Home: meta lines break inside a phrase ("· 6 / hours ago · +40 h"), and "Needs review" drops onto its own indented line. Add `whitespace-nowrap` to the time and hours, and put the pill in the meta line.
- Escape doesn't close the mobile nav drawer.
- The Portal tab bar's blur is weak enough that card titles show through under the labels. Use `bg-canvas/95` with a stronger blur.

**L2. Small copy and data mismatches.**
- The client page invite placeholder is `owner@brandlord.com`, but the client's domain is brandlord.co (`studio/a_northbeam_clients_brandlord-light-desktop`).
- On the Portal agent page, "choose files" is still a red link (r3 H1 said links should be ink).
- Times are formatted two ways: "Every Monday at 6 AM" and "Next today at 6:00 AM".

**L3. Revisiting a hired discovery flashes the reading screen.**
- Route: `/a/northbeam/agents/new?d=371814e9…`, mobile.
- Screen: `flow/a_northbeam_agents_new_d_371814e9…-light-mobile.png`.
- What the user sees: Back from the agent page shows "The Architect is reading the call" with step 1 spinning, then redirects.
- Fix: for a discovery whose status is `hired`, redirect on the server.
