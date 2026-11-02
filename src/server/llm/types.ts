/**
 * Provider-neutral LLM contract. Messages use the Anthropic (beta) Messages API shapes as the lingua franca so the
 * real provider can append `response.content` verbatim (thinking blocks included) and the offline provider reads
 * the exact same conversation.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ModelTier = "smart" | "fast";

export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmContent = Anthropic.Beta.BetaContentBlockParam;

export type LlmToolDef = {
  name: string;
  description: string;
  /** JSON Schema (type: object). */
  input_schema: Record<string, unknown> & { type: "object" };
};

export type LlmToolCall = { id: string; name: string; input: unknown };

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";

export type LlmRequest = {
  tier: ModelTier;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
};

export type LlmResponse = {
  model: string;
  stopReason: LlmStopReason;
  /** Concatenated visible text of the turn. */
  text: string;
  toolCalls: LlmToolCall[];
  /** Assistant content to append to the conversation unchanged. */
  assistantContent: LlmContent[];
  usage: LlmUsage;
};

export interface LlmProvider {
  readonly id: "anthropic" | "offline";
  chat(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
