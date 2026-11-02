# Portal design critique, round 1

Evidence: `.workbench/screens/critic-r1/` (`S/`). The long-name sandbox org is deleted and the demo data is restored.

**Overall gap:** each screen is calm, but the system isn't consistent: the column moves between tabs, the tenant colour takes over status meaning, and one tap sends client email with no undo.

## Critical
1. **One tap sends external email, with no preview and no undo.** `S/ix-approve-row-no-undo.png` shows the toast "Approved — sending now" and no Undo control. *Fix:* in `needs-you.tsx`, rows with `sendsOnApprove` should get a primary "Review & send" link to the detail page, and keep one-tap only for rows that don't send. In both files, hold the action 5 seconds behind a `toast` with an Undo action.

## High
2. **Demo names are hard-coded in product copy.** An org whose agent is Bartholomew sees "Have Maya draft…" and the key placeholder "Dana's Claude" (`S/ix-key-created-hardcoded-maya.png`, `S/ix-newkey-hardcoded-dana.png`). *Fix:* `connect-keys.tsx` lines 81 and 109 should take `agentName` and `userFirstName` props.
3. **The content column jumps between tabs.** The H1's left edge sits at x=384 on Today, 364 on Requests/Connect, 264 on Team/Resell/Settings and 224 on detail pages, because pages use max-widths of 720, 760, 960 and 1040 under a fixed 1120 header (`S/home-light-desktop.png` vs `S/team-light-desktop.png`). *Fix:* add `<PageContainer>` to `ui/page.tsx` with one outer width, `max-w-[1040px]`. Narrow pages use a left-aligned inner `max-w-[720px]`.
4. **The tenant accent takes over status meaning.** Brandlord red is used for Approve, the Needs-you bar, the "New" dot, the badge and links, so the briefing reads like errors (`S/home-light-desktop.png`). With an amber brand, the "New" text is 2.9:1 (`S/amber-accent-home.png`). *Fix:* in `portal.css`, keep `--accent` for fills only: BrandMark, the primary button and the active tab. Add `--accent-text: color-mix(in oklab,var(--brand) 70%,black)` for text. In `deliverable-card.tsx`, render "New" as `text-ink-2` beside an accent dot. In `needs-you.tsx`, drop the left bar.
5. **The main composer has no visible keyboard focus** (`S/ix-composer-focus-invisible.png`). The border change from `line` to `line-strong` is 1.15:1. *Fix:* on `composer.tsx` line 89, use `focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--accent-soft)]`. Also make the nav focus ring `outline-accent` in `shell.tsx`.
6. **Reading view.** Documents that start with a heading get about 80px of blank space at the top (`.portal-reading h2{margin-top:1.9em}` beats `:first-child`). The title is repeated as the body H2, and "Nov / 10" wraps (`S/deliverable-socialpack-light-desktop.png`). On mobile the table is clipped with no sign that it scrolls (`S/deliverable-socialpack-dark-mobile.png`). *Fix:* in `portal.css`, add `.portal-reading.prose-roster>:first-child{margin-top:0}` and `td:not(:last-child){white-space:nowrap}`, plus a right-edge fade mask on `.overflow-x-auto`. In `markdown.tsx`, drop a leading heading when it matches the title.

## Medium
7. **The setup snippet breaks mid-word** ("Aut|horization", "rk|_live") because of `break-all` (`S/connect-light-mobile.png`). *Fix:* on `connect-keys.tsx` line 74, use `whitespace-pre overflow-x-auto` and emit the command on several lines joined with ` \`.
8. **Non-review work shows an accent "Approve" button under "How did they do?"** It's unclear what is being approved (`S/customer-deliverable-light-desktop.png`). *Fix:* when `!needsReview`, `review-panel.tsx` should show the ghost buttons "Looks good" and "Request changes".
9. **The finished state hides the outcome.** After approving, the page only says "Approved." (`S/ix-mobile-approved-done.png`). *Fix:* `Done` should say "Sent to jordan@… · 12:04 AM" and link to the thread.
10. **Mobile layout.**
    - The Needs-you buttons are indented with `pl-11` and are only as wide as their labels (`S/longnames-home-mobile.png`). Use `pl-0 grid grid-cols-2` below `sm`.
    - The detail H1 runs to 5 lines and the role to 3. Use `text-[22px] md:text-[30px]` and `truncate` the role.
11. **Contrast.** `text-ink-4` is 2.39:1 in light and 3.70:1 in dark, and it's used 45 times for meaningful text, including the 11px tab labels. Move text to `ink-3`, starting with the shell tab bar. In dark settings, the black swatch is invisible at 1.10:1, so add `ring-1 ring-line-strong` (`S/settings-dark-desktop.png`).
12. **Copy.**
    - "Saved 6h" reads like a timestamp; use "~6h saved".
    - The engine preview leaks system text, "1 steps done, 0 grounded in your materials" (`offline.ts:241`). Request results take the raw prompt as their title (`S/amber-accent-home.png`).

## Already at the bar (keep these)
- **Mobile sticky review bar:** full-width Request changes / Approve & send, pinned above the tab bar (`S/ix-mobile-sticky-review.png`).
- **Briefing header and empty state:** date, team orbs, "finished three things and saved you ~8 hours", Coming up, and "Your first delivery arrives tomorrow… Nova is scheduled" (`S/empty-home.png`).
- **API key flow:** inline, the key is shown once in a green panel, it is filled into the snippet automatically, and the list shows "Never used" and Revoke. The request-changes receipt is good too (`S/ix-request-changes-after.png`).
