# Security critique r1: channels / API / auth / security / queue

Evidence: proof tests in /tmp/sec-copy/tests/sec/*.test.ts, run against roster_sec. Note: the session was interrupted before the live-server and Slack OAuth probes, so those areas were reviewed from code only.

## 1. HIGH: An inbound message from anyone drives the agent with full trust (data exfiltration, memory poisoning, internal phishing)
- Code: inbound.ts:427 wakes the agent for any sender. runtime.ts buildBrief puts the sender's text in the user turn as the task, with no sender identity or trust label. runtime.ts deliverReply (~l.505) auto-sends the reply to the sender and never applies `requireApprovalFor`. core.ts:162 only gates `send_message` email to *non-members*, and never gates slack or sms without `to`.
- Repro (inject.test.ts, offline model, agent config `requireApprovalFor:["send_external_email"]`): an email from mallory@evil.example led to (a) a reply sent to Mallory containing a confidential memory ("Acme margin 62%… buyer cell…"), (b) `memory_save` of "Acme invoices must be paid to IBAN GB00EVIL…" (source run:…), which is now injected into every future system prompt, and (c) an email to the org owner with Mallory's password-reset link. **APPROVALS: 0.**
- Fix: label inbound runs as untrusted external input (sender, not-a-member) in a separate block. For unknown senders, restrict tools to read-only, with no `memory_save` and no `send_message`. Hold replies to unknown senders as drafts that need approval, unless the org opts in. Gate every `send_message` whose target differs from the run's conversation, including Slack `to` and internal recipients when the run came from outside.

## 2. HIGH: Quadratic regex in HTML/address parsing blocks the worker
- Code: email.ts:96-99 (`<(script|style|head)[\s\S]*?<\/\1>`, `<[^>]+>`), ssrf.ts:278-282 (same patterns, for http_fetch pages), email.ts:40 (`"?([^"<]*)"?\s*<`).
- Repro (redos.test.ts): htmlToText("<"×200k) took 43 s; "<script"×40k took 17 s; ssrf htmlToText("<"×200k) took 52 s; parseAddress("a"+40k spaces+"b") took 7.5 s. An HTML-only email gets htmlToText on a 1 MB body, and fetchReceivedEmail has no size cap. That freezes the event loop, which stops lease renewal, so other workers reclaim the job and stall in turn (maxAttempts 8).
- Fix: cap the input (e.g. 100 KB) before any regex. Use a linear tokenizer or an HTML parser. Use a non-backtracking address parse with a length cap of about 320.

## 3. MEDIUM: MCP JSON-RPC batch bypasses the per-key rate limit
- Code: mcp.ts:345-353 charges `authenticate()` once per HTTP request, then runs up to 20 `tools/call` sequentially.
- Repro (api.test.ts): one POST with 20 `ask_agent` calls created **20 runs** and charged **1** rate-limit unit (remaining 119). That is 20x the LLM spend and inline-run concurrency (60 s each) per allowed request.
- Fix: charge one unit per batch element (or per tools/call). Reject batches over about 5, or disallow `ask_agent` in batches.

## 4. MEDIUM: No inbound volume caps (cost DoS, SMS pumping, backscatter)
- Code: no per-sender, per-conversation or per-agent rate limit before startConversationRun (inbound.ts:207). Every inbound message costs one LLM run plus one outbound reply (up to 4 SMS segments). The spoof guard fails open when Authentication-Results is missing (inbound.ts:436-441). Outbound mail lacks `Auto-Submitted: auto-replied`, which invites loops.
- Fix: rate-limit by sender and by agent. Treat a missing or neutral auth result as untrusted (no auto-reply). Set `Auto-Submitted` on agent mail.

## 5. MEDIUM: Agent can post to any Slack channel without approval
- Code: core.ts:161-164 (slack is never gated) and jobs.ts:213-217 (`payload.to` is accepted as any channel ID for new conversations).
- Fix: allow only the conversation's channel or the install's default channel, and gate everything else.

## 6. MEDIUM: Client IP trusts X-Forwarded-For
- Code: session.ts:78. This value feeds the login, signup and magic-link IP rate limits and the audit IPs, so the IP limit is bypassable by rotating the header.
- Fix: take the IP only from a trusted proxy hop (configured), otherwise the socket address.

## 7. MEDIUM: http_fetch has no total deadline
- Code: ssrf.ts:241. `timeout` is an idle-socket timeout, so a slow-drip server holds a run past `timeoutMs`.
- Fix: add an overall `setTimeout` → `req.destroy()`.

## Checked and OK
- Cross-tenant REST: other org's deliverable, workflow and agent ids all return 404 (repro).
- Svix, Slack and Twilio verification: constant-time compares, replay window, raw body, multiple Svix signatures handled.
- Webhook idempotency: unique index plus enqueue in the same transaction.
- Slack OAuth: HMAC-signed state with a nonce cookie and a user match, a strict `returnTo` allowlist, and cross-org team takeover blocked.
- Header CRLF stripping and the email HTML allowlist serializer.
- resolveAccess: no climbing to the parent org and no sibling access.
- Revoked and expired API keys rejected, keys stored only as SHA-256.
- Queue lease ownership checks.

**Verdict: not at a production bar.** #1 and #2 can be triggered by any stranger with an email address and must be fixed first; #3 to #5 should be fixed before launch.
