# Studio design critique: round 1

Fresh screenshots (2 themes × 2 viewports, 18 routes) plus a real hero run (podcast chunk → Hire). References from memory. Evidence: `.workbench/screens/critic-r1/NN-*.png`. **Verdict: not at the bar.** The hero flow breaks at both ends.

**Biggest gap per screen.** Home: approvals sit below 8 deliverables on mobile (10). New agent: dead button (05). Reading: says "ready" at step 2 of 5 (01, 02). Review: a form, not a proposal (12). Agent: zeros after hire (03). Billing: overflow and empty bars (09, 14). Clients: "No plan" shown as Active (15). Client: one keypress can cancel billing (08). Blueprints: empty state has no CTA.

## Critical
**C1. The hero promise disappears after Hire (03, 04).** The proposal named a first deliverable, 6 knowledge requests and 7 client questions. The agent page shows four 0 tiles and "No deliverables yet". *Fix* `agents/[agentId]/page.tsx`:
- Join `discoveries.agent_id` and render a pending row: `{firstDeliverable.title} · Queued · lands ~7 AM`.
- Add a "Before tonight" checklist (Upload per knowledge need, "Copy questions as email").
- Hide the Stat strip while `runs===0`.
- While provisioning, render the `provisioning.tsx` checklist instead of zeros.

**C2. The reading state lies (01, 02).** The headline says "Proposal ready" while 3 steps still spin. The quotes are client-side regex output with raw markdown (`“**10:32** · …`) and don't match the proposal. *Fix* `reading.tsx`:
- Show the title only when `step >= STEPS.length`.
- Strip `/^\*\*\d+:\d+\*\*\s*·\s*/` from quotes.
- Once ready, swap in `proposal.workflows[].itch` and list the workflow names.

## High
**H1. Compose dead end (05).** With a transcript pasted and no client chosen, the button is gray and ⌘↵ is silent. *Fix* `flow.tsx`: keep the button enabled; with no client, open ClientPicker and show "Choose who this is for". Show `Ctrl ↵` on non-Mac.

**H2. ⌘K misranks (06, 07).** "tess" → *Invite a teammate* first, agent Tess last. "coast" → the Coastal client lands below the fold. Cause: `command-palette.tsx` uses `value={`${label} ${group} ${id}`}`, so group names and UUIDs get fuzzy-matched. *Fix*: `value={it.label}` plus a `filter` that ranks prefix (1), then word-prefix (.8), then keyword (.4), else 0. Show entity groups first while there is a query.

**H3. One keypress cancels billing (08).** `PlanSelect` (`client-dialogs.tsx`) calls `setClientPlan` on change, and its "No plan" option cancels the subscription. *Fix*: show the plan as text with a "Change plan" confirm dialog. Make cancelling a separate destructive action.

**H4. Mobile (09, 10, 11).**
- Billing renders 437px wide at 390. The `sr-only` "Cost share" span escapes `overflow-x-auto`; add `relative` at `billing/page.tsx:87`.
- Home: add `max-lg:order-first` to the Needs-attention column.
- Agent tabs cut off at "Activi": add an edge `mask-image` and scroll the active tab into view.
- Approval banner: give the text `basis-64` so the actions wrap below it.

## Medium
**M1. The review is noisy (12, 13).**
- 6 channel chips per workflow → one "Portal, Email ▾" menu. Show controls on hover/focus only.
- The hours input is `w-9`, so "0.75" shows as "0.7" → `w-[4.5ch]`.
- Two workflows cite the same quote (engine: dedupe).
- The price shows $5,000 for a $500-plan client: `agents/new/page.tsx` uses the agency's first plan.
- The mobile hire bar is `bg-canvas/90` and text bleeds through → make it solid.

**M2. Glossy marble avatars** (`ui/agent-orb.tsx`: radial highlight plus a conic gradient) are the strongest "AI template" tell, and the only cue separating the two Mayas. → flat `linear-gradient(135deg,a,b)`, lower chroma, white initial.

**M3. Contrast.** Light `--ink-4` #8e8e96 is 3.0:1 on canvas and fails AA on every timestamp and meta line. → `--ink-4:#72727a`, `--ink-3:#5c5c66`.

**M4. Billing and clients (14, 15).**
- The bars plot cost share, so 99.9% margin draws as an empty track → drop the column.
- Show "99.9%" not "99.89%", and "$0.94" not "$0.942".
- Merge Subscriptions into the Margin table.
- Show "No plan" clients with a neutral badge.

**M5. Copy.** "Agents › Brandlord" → "Brandlord › Maya". "1 chunks". "Invite the owner" shows when an owner exists.

## Already at the bar
1. Provisioning (17): the stack checks off in order, then "Tess is on the roster", then "Meet Tess". Calm and honest.
2. Review rail (18): sticky "Saves about 28.8 h/week" with Hire.
3. The shell: shortcut hints, focus rings (19), mobile drawer, branding preview.
