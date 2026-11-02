/**
 * Exercises the real Anthropic provider (request shape, response/usage mapping, error mapping, and the runtime's
 * tool loop with thinking blocks passed back) through a stubbed fetch, so no API key or network is needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { db, schema } from "@/server/db/client";
import { setLlmProviderForTests } from "@/server/llm";
import { anthropicProvider, setAnthropicFetchForTests } from "@/server/llm/anthropic";
import { hireAgent, messageAgent } from "@/server/services/engine";
import { makeOrgs, resetDb } from "./engine.helpers";

type Captured = { body: Record<string, unknown>; headers: Headers };

function stub(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Captured[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: new Headers(init?.headers) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as typeof fetch;
  return { f, calls };
}

const message = (content: unknown[], stop: string, model = "claude-opus-5-5") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
});

afterEach(() => {
  setAnthropicFetchForTests(undefined);
  setLlmProviderForTests(null);
});

describe("anthropic provider", () => {
  it("sends adaptive thinking, effort, tools and the fallback beta; maps tool calls, thinking and usage", async () => {
    const { f, calls } = stub([
      {
        json: message(
          [
            { type: "thinking", thinking: "Look it up first.", signature: "sig" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "knowledge_search", input: { query: "quotes" } },
          ],
          "tool_use",
        ),
      },
    ]);
    setAnthropicFetchForTests(f);
    const res = await anthropicProvider.chat({
      tier: "smart",
      system: "You are a test.",
      systemVolatile: "## Now\nIt is noon.",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "knowledge_search", description: "Search", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
      maxTokens: 1000,
    });
    const req = calls[0]!;
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 1000, thinking: { type: "adaptive" }, output_config: { effort: "high" }, fallbacks: "default" });
    // Prompt caching: breakpoint after the stable system prompt (+ tools), automatic caching for the growing tail.
    expect(req.body.cache_control).toEqual({ type: "ephemeral" });
    expect(req.body.system).toEqual([
      { type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "## Now\nIt is noon." },
    ]);
    expect((req.body.tools as unknown[]).length).toBe(1);
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "knowledge_search", input: { query: "quotes" } }]);
    expect(res.text).toBe("Checking.");
    expect(res.assistantContent[0]).toMatchObject({ type: "thinking", signature: "sig" });
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  it("maps rate limits to retryable errors and bad requests to non-retryable ones", async () => {
    const err = (type: string) => ({ type: "error", error: { type, message: "nope" } });
    setAnthropicFetchForTests(stub([{ status: 429, json: err("rate_limit_error") }]).f);
    const req = { tier: "fast" as const, system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxTokens: 10 };
    await expect(anthropicProvider.chat(req)).rejects.toMatchObject({ retryable: true });
    setAnthropicFetchForTests(stub([{ status: 400, json: err("invalid_request_error") }]).f);
    await expect(anthropicProvider.chat(req)).rejects.toMatchObject({ retryable: false });
  });
});

describe("runtime on the anthropic provider", () => {
  beforeEach(resetDb);

  it("runs the tool loop, passes thinking back unchanged, and meters real cost", async () => {
    const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");
    const orgs = await makeOrgs({ clientName: "Summit Promo Co", industry: "Promotional products distribution" });
    const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name, industry: orgs.client.industry });
    const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "user", userId: orgs.user.id } });

    const { f, calls } = stub([
      {
        json: message(
          [
            { type: "thinking", thinking: "Search the call notes.", signature: "sig-1" },
            { type: "tool_use", id: "toolu_a", name: "knowledge_search", input: { query: "quote hours" } },
          ],
          "tool_use",
        ),
      },
      { json: message([{ type: "text", text: "Quotes take about 20 hours a week today; I can draft them overnight." }], "end_turn") },
    ]);
    setAnthropicFetchForTests(f);
    setLlmProviderForTests(anthropicProvider);

    const r = await messageAgent({
      orgId: orgs.client.id,
      agentId,
      channel: "portal",
      text: "How long do quotes take us?",
      actor: { type: "user", userId: orgs.user.id },
      wait: true,
    });
    const [run] = await db().select().from(schema.runs).where(eq(schema.runs.id, r.runId));
    expect(run!.status).toBe("succeeded");
    expect(r.reply).toMatch(/20 hours a week/);
    expect(calls).toHaveLength(2);

    // Second request: assistant turn with the thinking block (signature intact) + a tool_result for toolu_a.
    const msgs = calls[1]!.body.messages as Array<{ role: string; content: unknown }>;
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "thinking", signature: "sig-1" })]));
    const lastUser = JSON.stringify(msgs[msgs.length - 1]);
    expect(lastUser).toContain("toolu_a");
    expect(lastUser).toContain("tool_result");

    const usage = await db().select().from(schema.usageEvents).where(eq(schema.usageEvents.runId, r.runId));
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.model === "claude-opus-5-5" && Number(u.costMicros) > 0)).toBe(true);
  });
});
