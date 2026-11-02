# Design critique, round 3

Evidence: `.workbench/screens/critic-r3/NN-*.png`: 76 screenshots plus every flow. Test keys revoked and test agent archived afterwards.

**Studio: 7/10.** Calm, consistent and the hero states are good. One mobile layout breaks badly, and the Architect's output has copy bugs.
**Portal: 7.5/10.** Today, review with Undo, and request changes are at the bar. The tenant red is used for UI state, and Connect is written for developers.

**Gap per screen.** Home: mobile titles. Client: header. Knowledge: URL field. Billing: mobile margin. Connect: Twilio. Resell: leak. Today and deliverable: none.

## Critical
**C1. The client header breaks on mobile (01).** The name shows as "Bran", the buttons cover it, and the meta line wraps one word per line, 20 lines in all. *Fix* `clients/[clientSlug]/page.tsx:43`: add `basis-64` to the middle div. Give the actions div `max-sm:w-full`.

## High
**H1. The tenant red signals state (04, 05, 06).** Toggles, the selected radio card, focus rings and links are red, so they read as errors. *Fix* `portal.css`: keep `--accent` for the brand mark, the primary CTA, the active tab and the dot. For controls:
- Checked switch: `--ink`
- Selected card: `border-ink bg-surface-2`
- Focus ring: ink at 30%
- Links: ink with an underline

**H2. Connect (02).** The copy icon covers the command ("Authori▢atic"). Dana is told to set up Twilio webhooks.
- `connect-keys.tsx:121`: put `CopyButton` beside the `pre` (`min-w-0 flex-1`), not on top of it.
- `sms-connect.tsx:153`: on the portal, show "Ask {agency} to give Maya a number". Keep the Twilio form in Studio only.

**H3. White-label leaks (03).** "Stripe isn't connected to Roster yet" (`connect-stripe-card.tsx:22`, `checkout-links-card.tsx:33`). The MCP server is named `roster` (`mcp-config.ts:23`). Drop "Roster" from the copy and name the server after the org slug.

**H4. The hero output (07, 08).** The new Coastal agent was named "Quinn", but Coastal already has a Quinn, so the inbox is `quinn-9c79@`.
- `architect.ts:1026`: skip names already used in the agency. "Lena" is in the name list and is a demo user.
- `:897`: "The the weekly…".
- `:1071`: the offline disclaimer is question #1, so it ends up in "Copy as email to client". Make it a proposal-only notice.

**H5. Mobile hides data.** Home titles cut off at "Draft: weekly st…" (09): in `a/[agency]/page.tsx:90`, use `line-clamp-2` and stack time and hours under `max-sm`. Billing scrolls Margin off-screen with no hint (10): in `billing/page.tsx:98`, use stacked rows with the margin % on the right.

## Medium
- **M1. Stale attention (12).** "Asked for changes · 3 hours ago" is a note sent a minute earlier, and it stays after the revision lands. Use the feedback's timestamp and clear the item on revision.
- **M2. Knowledge (11).** The URL field is 105px (`knowledge-form.tsx:47` `[1fr_200px]`). Stack the fields. A source is titled "Discovery call: Discovery call…".
- **M3. Left edges.** Titles start at x=340, 440 on Settings and 480 on New agent. On agent Settings, the Channels card is 640px and the form 720px (13).
- **M4. Repeated confirmations.** Ask, upload and the approve hold each confirm two or three times (14, 20). Keep one.
- **M5. Client detail (19).** "Billing · Active" sits next to "Stripe isn't connected". "Cancel subscription" is red at rest: move it into "…".
- **M6. Mobile polish.** Landing workflow rows wrap to 3 lines (15). Keyboard hints in the drawer.
- **M7. Contrast.** `--ink-4` is 3.0:1 on the canvas and still appears 42 times.

## Fixed since r1
- The agent page after hire shows the first deliverable queued and a "Before tonight" list
- Compose button works
- ⌘K ranks results correctly
- Changing the plan needs a confirm
- Mobile shows attention first
- Flat avatars
- One channel menu in the review
- Margin shown as %
- Review & send has a 5s Undo
- No hard-coded names
- Portal left edge is consistent
- "New" uses ink with a dot
- Reading view fixed
- "Looks good" shows on work that doesn't need review

## Still open
- The reading header says "Finishing" at step 2 of 5, and the quote has no closing ”
- Tenant accent drives UI state
- No mask on the agent tabs
- `ink-4` contrast
- The snippet no longer wraps mid-word, but the copy icon now covers it
