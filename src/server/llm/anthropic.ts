/**
 * Anthropic Claude provider (Messages API, manual tool-use loop driven by the runtime).
 *
 * - Adaptive thinking; thinking blocks are passed back unchanged via `assistantContent`.
 * - Server-side refusal fallbacks (`fallbacks: "default"`) on models that support them.
 * - Typed SDK errors are mapped to retryable / non-retryable `LlmError`s.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/server/env";
import type { LlmProvider, LlmRequest, LlmResponse, LlmStopReason, ModelTier } from "./types";
import { LlmError } from "./types";

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export function modelFor(tier: ModelTier): string {
  return tier === "smart" ? env().ROSTER_MODEL_SMART : env().ROSTER_MODEL_FAST;
}

let client: Anthropic | undefined;
let testFetch: typeof fetch | undefined;
function anthropic(): Anthropic {
  if (!client) {
    client = testFetch
      ? new Anthropic({ apiKey: "test-key", fetch: testFetch, maxRetries: 0 })
      : new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 180_000, maxRetries: 2 });
  }
  return client;
}

/** Tests only: route SDK HTTP through a stub so the real request/response mapping is exercised without a key. */
export function setAnthropicFetchForTests(f: typeof fetch | undefined): void {
  testFetch = f;
  client = undefined;
}

function mapStop(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    default:
      return "other";
  }
}

export function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof Anthropic.RateLimitError) return new LlmError("Model rate limited", true);
  if (err instanceof Anthropic.InternalServerError) return new LlmError("Model provider error", true);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("Model request timed out", true);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError("Model connection failed", true);
  if (err instanceof Anthropic.AuthenticationError) return new LlmError("Model authentication failed", false);
  if (err instanceof Anthropic.BadRequestError) return new LlmError(`Model rejected request: ${err.message}`, false);
  if (err instanceof Anthropic.APIError) return new LlmError(`Model API error ${err.status ?? ""}`.trim(), (err.status ?? 0) >= 500);
  return new LlmError(err instanceof Error ? err.message : String(err), false);
}

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  async chat(req: LlmRequest): Promise<LlmResponse> {
    const model = modelFor(req.tier);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens,
      // Prompt caching: an explicit breakpoint after the stable prefix (tools + stable system prompt), plus top-level
      // automatic caching so each loop turn re-reads the growing conversation instead of re-billing it.
      system: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
        ...(req.systemVolatile ? [{ type: "text" as const, text: req.systemVolatile }] : []),
      ],
      cache_control: { type: "ephemeral" },
      messages: req.messages,
      thinking: { type: "adaptive" },
      output_config: { effort: req.tier === "smart" ? "high" : "low" },
      ...(req.tools.length ? { tools: req.tools as Anthropic.Beta.BetaTool[] } : {}),
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await anthropic().beta.messages.create(params, { signal: req.signal });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const toolCalls: LlmResponse["toolCalls"] = [];
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const u = res.usage;
    return {
      model: res.model ?? model,
      stopReason: mapStop(res.stop_reason),
      text,
      toolCalls,
      assistantContent: res.content as unknown as Anthropic.Beta.BetaContentBlockParam[],
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  },
};

/** Single structured-output call (used by the Architect). Returns raw JSON text; caller validates with zod. */
export async function anthropicStructured(input: {
  tier: ModelTier;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<{ text: string; model: string; usage: LlmResponse["usage"] }> {
  const model = modelFor(input.tier);
  try {
    const stream = anthropic().beta.messages.stream({
      model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: input.schema } },
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const res = await stream.finalMessage();
    if (res.stop_reason === "refusal") throw new LlmError("Model declined the request", false);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return {
      text,
      model: res.model ?? model,
      usage: {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw mapAnthropicError(err);
  }
}
