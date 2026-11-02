/**
 * Internal cost metering (agency margin view only — never shown to clients).
 * Prices are USD per 1M tokens, which is conveniently micro-dollars per token.
 */
import type { LlmUsage } from "./types";

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "roster-offline-1": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Conservative default for unknown model ids (priced like the smart tier). */
const FALLBACK: Price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export function priceFor(model: string): Price {
  return PRICES[model] ?? FALLBACK;
}

/** Cost in micro-dollars (1e-6 USD), rounded up so metering never under-reports. */
export function costMicros(model: string, usage: LlmUsage): number {
  const p = priceFor(model);
  const total =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite;
  return Math.ceil(total);
}
