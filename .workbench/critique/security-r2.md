# Security critique r2: actions, auth, invites, portal and r1 re-check

Method: snapshot /tmp/sec2, DB roster_sec, live dev server on :3102, with actions called by `Next-Action` id. Proof tests are in /tmp/sec2/tests/sec/.

## HIGH

**H1. A forged Authentication-Results header makes a spoofed email trusted.**
- **Code:** inbound.ts:481-487. When `EMAIL_AUTHSERV_ID` is unset (the default), any first AR header is trusted.
- **Repro (inject2.test.ts):** `From: <owner email>` plus a self-written `Authentication-Results: mx.evil.example; dmarc=pass`.
  - The message got `senderAuth:"pass"` and `senderUserId=owner`.
  - The IBAN memory was saved and the margin was replied. **APPROVALS: 0.**
- **Precondition:** the provider does not put its own AR header first.
- **Fix:** fail closed unless `EMAIL_AUTHSERV_ID` is set and matches, and require it in production. Gate `memory_save` on email runs.

**H2. Accounts can be pre-registered under someone else's email (pre-hijack).**
- **Code:**
  - signUp (auth)/actions.ts:99-100: creates a session without verifying the email.
  - verifyMagicLink :147-156: signs into the existing account and keeps the attacker's password and sessions.
  - invite/[token]/actions.ts:54: matches the invite against the unverified `current.email`.
  - :83: marks the email verified for whoever holds the link.
  - p/[org]/actions.ts:354 and :497: always return `inviteUrl` to the inviter, even in production.
- **Impact:**
  1. An attacker signs up as bob@client.co.
  2. The real Bob later gets an invite and signs in by magic link.
  3. The attacker's session inherits Bob's memberships.
  - Any portal admin can also create email-verified accounts for any address.
- **Fix:**
  - Unverified accounts cannot accept invites.
  - On the first verification, clear `passwordHash` and other sessions.
  - Email invite links. Never verify from an inviter-visible link.

## MEDIUM

**M1. Open redirect after login and magic link.**
- **Code:** safeNext (auth)/actions.ts:30 accepts `"/\t/evil.com"`.
- **Repro (Playwright):** `/login?next=%2F%09%2Fevil.example`, then signing in → `final URL: http://evil.example/`.
- **Second route:** requestMagicLink puts this `next` into a genuine Roster email.
- **Fix:** `new URL(next, APP_URL)`, require the same origin, and redirect to `pathname+search`.

**M2. An agency *member* can create owner invites for any client.**
- **Code:** org.ts:105 (`"member"`).
- **Repro:** mem@northbeam.ai → `inviteClientOwner(...,"nora.personal@example.com")` → `{"ok":true,"link":…}`. The DB row has `role=owner`.
- **Impact:** persistent client-owner rights that survive removal from the agency.
- **Fix:** require `"admin"`.

**M3 (latent). Custom-domain hosts serve Studio and login.**
- **Code:** proxy.ts:14 and :68 (PASSTHROUGH).
- **Repro:** with `Host: team.brandlord.co`, POST /login as aj@ → a host-only `Set-Cookie: roster_session`, and `/a/northbeam` → 200.
- **Impact:** the client controls DNS for that host, so it can re-point the name and collect agency-owner sessions.
- **Current state:** no UI sets `custom_domain` yet.
- **Fix:** custom hosts serve only that org's portal and redirect auth, Studio and API paths to APP_URL.

## LOW

- **L1. Studio errors leak SQL text.** `fail()` (ctx.ts:42) forwards short internal errors.
  - `setPlanActive("northbeam","not-a-uuid")` returns `"Failed query: update \"plans\"… params: true,not-a-uuid,328250d5-…"`.
- **L2. IP rate limits depend on `TRUST_PROXY_HOPS`.**
  - With `0`, every user shares the `login:ip:unknown` bucket (session.ts:86), which locks everyone out.
  - With the default of 1 and no proxy, a client-set XFF of `203.0.113.9` was recorded as that IP.

## Checked OK (live)

- **Cross-tenant ids:** no DB change from:
  - askTeam, review, decideApproval, setWorkflowEnabled and offerAgent with another org's agent, customer or plan.
  - createApiKey with a foreign agentId.
  - revokeKey, savePlan, decide, hire and startDiscovery from another agency.
- **Roles:** the following are refused:
  - a viewer approving;
  - a member creating keys or changing branding;
  - a customer owner setting branding or reselling;
  - a customer member opening /p/brandlord (404).
- **Portal payloads:** 11 portal pages contain no cost, token, model, hash, budget or prefs fields.
- **Also OK:** atomic invite claim, no upload endpoint, knowledge URLs via `safeFetch`.

## Round-1 items

- **#1 Stranger email.** Fixed: 0 outbound, no memories, and 3 held approvals with safe text. Bypass: H1.
- **#2 ReDoS.** Fixed: every r1 input plus `"<!--"`×250k and 100k spaces takes ≤6 ms, and outputs are still correct.
- **#3 MCP batch.** Fixed: a 20-element batch → 400, and `ask_agent` is refused inside a batch. Each element is charged one unit.
- **#4 Inbound caps.** Fixed (code check): inbound.ts:204, email.ts:200.
- **#5 Slack.** Fixed (code check): core.ts:214.
- **#6 XFF.** Partly fixed (L2).
- **#7 Fetch deadline.** Fixed (code check): ssrf.ts:138-191.

**Verdict:** fix H1 and H2 before launch.
