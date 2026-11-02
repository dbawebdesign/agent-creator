# Design critique, round 5

Evidence: `.workbench/screens/critic-r5/design/`
- `studio/`, `portal/`: every route in light and dark, desktop (1440) and mobile (390).
- `flow/`: ⌘K (empty, "approve", "social", mobile), full-page Settings, agent Settings, workflow hover, Iris (stalled), Home full, mobile drawer + Esc, Portal Ctrl+K, request detail, deliverables, mobile full pages.

No side effects: nothing was clicked except opening ⌘K and the mobile drawer. Note: `/a/northbeam` and `/p/brandlord` never reach `networkidle` on the first load (the first capture timed out at 45s; later loads were fine). Worth checking for a polling loop.

**Studio: 8/10** (r4: 7.5). The stalled setup now has a way out, mobile workflows read well, ⌘K finds deliverables, Esc closes the drawer, and agent Settings has a sensible order. What holds it back: status that contradicts itself (stalled vs "Provisioning", "Verified" email that doesn't receive), status shown twice, and a roster sidebar that still truncates.

**Portal: 8.5/10** (r4: 8). "Test mode" and `.local` are gone from every client screen. Dark switches read correctly. Today has a "Coming up" rail, and Requests has the meta rail. Remaining gaps: no ⌘K, Connect hands out email addresses it says won't work, and mobile polish (tab bar bleed, table columns).

## r4 items re-verified

| r4 | Status | Evidence |
|---|---|---|
| C1 empty state while first deliverable is queued | **Not re-verified live.** No northbeam agent has a queued release. The queued ones belong to other test agencies, and I didn't hire on shared data. A `release-now.tsx` component exists. The lead should verify with one fresh hire. | n/a |
| H1 stuck provisioning, no exit | **Mostly fixed.** "Setup stalled at activation · Retry setup" card; Home says "Iris's setup stalled — retry". Leftovers in H2 below. | `flow/s08-iris-full-light.png`, `flow/s09-home-full-light.png` |
| H2 proposal vs transcript | Not re-tested (it needs a new discovery call on shared data). | n/a |
| H3 test mode / `.local` in portal | **Fixed.** A text scan of 9 portal routes finds no "test mode", "roster" or ".local". The only leftover is the soft "Billing isn't live yet" on Settings. | `portal/*`, `flow/p05-settings-full-light.png` |
| H4 mobile workflow rows | **Fixed on mobile:** titles wrap, schedule + next run on their own line, controls on a separate row. Desktop still shows 3 controls per row (L2). | `studio/…_workflows-dark-mobile.png`, `flow/s06-workflows-hover-light.png` |
| H5 dark switch looks disabled | **Fixed:** the on state has a near-white track and a dark thumb. | `portal/p_brandlord_settings-dark-desktop.png` |
| M1 portal ⌘K | Open | `flow/p01-cmdk-light.png` |
| M2 Studio ⌘K can't find work | Partly fixed: deliverables are indexed ("social" → 2 hits). | `flow/s03-cmdk-social-light.png` |
| M3 portal width / dead right third | **Fixed:** "Coming up" rail on Today; request detail has a meta rail. | `flow/p02-today-full-light.png`, `flow/p03-request-detail-light.png` |
| M4 roster sidebar | Open | every Studio shot |
| M5 agent settings order / dev copy | **Fixed:** order is Profile → Approvals → Channels → Lifecycle; the webhook copy is gone. | `flow/s05-agent-settings-full-light.png` |
| M6 Resell repeats itself | **Mostly fixed:** stat pair dropped, notice folded into the hero, plan row full width. Three create CTAs remain. | `flow/p06-resell-full-light.png` |
| M7 status twice | Open | see M4 below |
| L1 Esc closes drawer | **Fixed** | `flow/s13-m-drawer-after-esc-dark.png` |
| L2 portal "choose files" red link | **Fixed** (ink, underlined) | `portal/p_brandlord_team_18c8…-light-desktop.png` |

## Now at the bar
- **Portal Today (desktop).** Greeting, a one-line summary, the composer, "Needs your OK" first, and a quiet "Coming up" rail that shows the proactive side. Calm, dense, one accent (`flow/p02`).
- **Portal deliverable and request detail.** A reading column plus a meta rail on both, and the same rail layout across tabs, so widths no longer jump (`portal/p_brandlord_d_…-light-desktop`, `flow/p03`).
- **Portal client language.** Connect says "Ask Northbeam to give Maya and Theo a texting number". Settings and Resell no longer show engineering pills.
- **Portal dark mode.** Switches, the selected radio card and the salmon CTA all read clearly (`portal/…settings-dark-desktop`, `flow/p07`).
- **Studio stalled setup.** A named stage, a plain explanation, "Retrying is safe" and one primary button. Home echoes it with an arrow row (`flow/s08`, `s09`).
- **Studio mobile.** Workflow cards, the Home KPI grid with "Needs attention" above the feed, the drawer, and Esc to close (`studio/…_workflows-dark-mobile`, `flow/s15`).
- **Studio agent Settings.** Toggle list for approvals, Channels with "Connected · Brandlord", and the danger action last and red (`flow/s05`).
- **Studio ⌘K (desktop).** Grouped list, key hints, deliverables indexed with "agent · client" on the right (`flow/s01`, `s03`).

## Findings (ranked)

### High

**H1. Agent email says "Verified" in Studio, but the Portal says the same addresses won't receive anything.**
- Routes: `/a/northbeam/settings` (Agent email), the agent header (`maya@agents.northbeam.ai`), `/p/brandlord/connect`, `/p/brandlord/team/<id>`. All themes and viewports.
- Screens: `flow/s04-settings-full-light.png`, `flow/s16-m-settings-full-dark.png`, `portal/p_brandlord_connect-light-desktop.png`, `portal/p_brandlord_team_18c8…-light-desktop.png`.
- What the user sees:
  - AJ sees a green "● Verified (test mode)" next to `@agents.northbeam.ai`.
  - Dana sees two copyable address fields, each with a copy button, then the small print: "Email isn't switched on yet, so messages to these addresses won't arrive."
  - The agent page in the Portal also has a copy button on `maya@agents.northbeam.ai` with no warning.
  - The product invites Dana to copy an address that bounces, and tells AJ everything is fine.
- Fix: use one status source with three states: "Receiving", "Sending only" and "Not set up".
  - Studio: when inbound is off, show an amber pill "Not receiving yet" with the reason, not green "Verified". Repeat it as one line under the agent header address.
  - Portal: while inbound is off, don't render copy buttons or address fields. Show one muted line in the Email card: "Email addresses are on the way. Northbeam will switch them on." Hide the address chip on the agent page the same way.

**H2. A stalled agent still says "Provisioning" everywhere except the stalled card. The page around it is the same scaffolding as before.**
- Routes: `/a/northbeam/agents/39b2…` (Iris), `/a/northbeam/agents`, Home KPI. Desktop and mobile, both themes.
- Screens: `flow/s08-iris-full-light.png`, `studio/a_northbeam_agents-light-desktop.png`, `flow/s09-home-full-light.png`.
- What the user sees:
  - The header pill says "● Provisioning" (purple, calm) right above "Setup stalled at activation".
  - The agents list shows "Provisioning" and Home shows "5 · 1 provisioning".
  - Under the stalled card, the page still renders a dashed "No deliverables yet" panel, "Workflows 0 · No workflows yet", and "The stack", which repeats the same five rows the setup card just listed.
- Fix:
  - Derive a "Stalled" status (amber dot) and use it in the header pill, the agents list, the roster dot and the Home KPI subline ("1 stalled").
  - While the agent is not active, render only the setup card, plus one muted line: "Workflows and deliverables appear once Iris is set up."
  - Hide "The stack" until the agent is active (asked for in r4).

### Medium

**M1. The Portal still has no ⌘K** (r4 M1, unchanged).
- Route: `/p/brandlord/*`, desktop. Screen: `flow/p01-cmdk-light.png` (Ctrl+K does nothing).
- Fix: mount the shared `CommandPalette` in `components/portal/shell.tsx` with these groups:
  - Needs your OK
  - Recent deliverables
  - Teammates
  - An "Ask Maya…" action that pre-fills the composer
  - Pages
- Show a "Search ⌘K" hint in the top bar, next to the avatar.

**M2. Studio ⌘K still doesn't lead with work, and it is keyboard-centric on touch.**
- Route: ⌘K, desktop and mobile. Screens: `flow/s01-cmdk-empty-light.png`, `flow/s02-cmdk-approve-light.png`, `flow/s14-m-cmdk-dark.png`.
- What the user sees:
  - An empty query opens on generic Actions, while "Send the weekly status email to Lena Park" waits on Home.
  - Typing "approve" offers only "Review approvals and change requests", a navigation item, not the approval itself.
  - On mobile, the placeholder is cut ("…or type a") and the "↑↓ to move ↵ to open esc to close" footer and the "C" key hint are still shown.
- Fix:
  - With an empty query, put a "Needs attention" group first, using the same items as Home: "Review: Send the weekly status email…" and "Retry Iris's setup".
  - Index pending approvals by their text.
  - Under `pointer: coarse`, hide the footer and the kbd hints, and shorten the placeholder to "Search or jump to…".

**M3. Studio Home's top rows look auto-generated.**
- Route: `/a/northbeam`, desktop and mobile, both themes. Screens: `flow/s09-home-full-light.png`, `flow/s15-m-home-full-dark.png`.
- What the user sees:
  - The two newest "Delivered overnight" rows are "Nightly supplier price sync / Nightly supplier price sync is ready." and "Overnight migration / Overnight migration is ready." The summary just repeats the title. That's the first thing AJ reads, and it looks generated.
  - The first KPI is a big "$0 Monthly recurring" (sub "$15,500 not billed"), so the dashboard opens on a zero.
- Fix:
  - When the summary is just the title plus "is ready", don't render it. Show the meta line only, or have the engine return a one-line result ("14 SKUs updated, 2 quotes affected").
  - Lead the KPI with the contracted number, "$15,500 /mo", with the sub "Not billed yet · connect payouts". Show $0 only on Billing.

**M4. Status is still shown twice, and "Active" is repeated down every list** (r4 M7).
- Routes: agent header, client page agent cards, agents list. Screens: `studio/a_northbeam_agents_18c8…-dark-desktop.png`, `studio/a_northbeam_clients_brandlord-light-desktop.png`, `studio/a_northbeam_agents-light-desktop.png`.
- What the user sees:
  - A green dot on the avatar and "● Active" beside the name.
  - Client cards show a dot on the avatar and "● Active" under the role.
  - "Active" appears on 5 of 6 rows of the agents table.
- Fix: show only the exceptions (Paused, Stalled, Setting up) as one status component. Drop the avatar dot or the label, not keep both. In the agents table, show the status column empty when Active, or use a dot with no label.

**M5. The roster sidebar still truncates and duplicates** (r4 M4).
- Route: every Studio page. Screen: any `studio/*-desktop.png`.
- What the user sees: "Summit Agency Soft…", and two "Maya" rows that differ only by a grey client label. The list is a flat list in no clear order.
- Fix: group by client, with the client as a quiet 11px sub-heading and its agents indented beneath. That removes both the truncation and the ambiguity. Keep a stable alphabetical order by client.

**M6. Agency Settings: the save scope is unclear, and Agent email doesn't match the sections around it.**
- Route: `/a/northbeam/settings`, desktop and mobile. Screens: `flow/s04-settings-full-light.png`, `flow/s16-m-settings-full-dark.png`.
- What the user sees:
  - "Save settings" sits under a divider halfway down the page. It is unclear whether it covers Agent email and Team below it (it doesn't).
  - Agent email is a bare row: domain in mono, a pill, "Change" and "Remove" as same-weight text buttons. Team and API keys right below are carded lists.
  - "Remove" is a destructive action at rest, with no hierarchy.
- Fix:
  - Put the domain in the same card-row pattern as Team: domain, status pill and a "…" menu holding Change, and Remove with a confirm.
  - Make save per-section: a "Save" button inside the profile+branding block that only appears when the form is dirty, with "Saved" inline.

### Low

**L1. Mobile polish.**
- Studio Home meta lines still break inside a phrase ("57 minutes / ago", "8 / hours ago"), and the "Needs review" pill drops onto its own indented line (`flow/s15-m-home-full-dark.png`). Fix: `whitespace-nowrap` on the time and hours, and put the pill inline in the meta line.
- The Portal tab bar still lets card titles show through in dark ("Four Corners — November social pack" visible under the labels, `flow/p07-m-today-full-dark.png`). Fix: `bg-canvas/95` with `backdrop-blur-md`.
- On a mobile deliverable, the content table scrolls sideways and hides the Caption column, which is the one that matters (`flow/p08-m-deliverable-full-dark.png`). Fix: under `max-sm`, render markdown tables as stacked cards: label, then value.
- The invite placeholder on mobile Settings is clipped to "teammate@agency.con" (`flow/s16`). Fix: shorter placeholder ("Email").

**L2. Small mismatches.**
- The client page invite placeholder is `owner@brandlord.com`, but the domain is brandlord.co (`studio/a_northbeam_clients_brandlord-light-desktop.png`; r4 L2, still open).
- Portal agent page time formats: "Every Monday at 6 AM" next to "Next today at 6:00 AM".
- Portal Settings says "Billing isn't live yet, so no card is needed…". Better: "Northbeam handles your billing. Nothing to set up here."
- Studio desktop workflow rows still show Run now, Edit and the switch at rest (`flow/s06`). Fix: show "Run now" on row hover or focus only (Linear).
- Resell still has three create CTAs: Add a customer, Offer a teammate, New plan.
