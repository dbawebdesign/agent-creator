import { isOfflineModel } from "@/server/env";
import { anthropicProvider, modelFor } from "./anthropic";
import { OFFLINE_MODEL, offlineProvider } from "./offline";
import type { LlmProvider, ModelTier } from "./types";

export * from "./types";
export { costMicros } from "./pricing";
export { OFFLINE_MODEL } from "./offline";

let override: LlmProvider | null = null;

/** Test hook: force a provider (e.g. a scripted fake). Pass null to restore. */
export function setLlmProviderForTests(p: LlmProvider | null) {
  override = p;
}

export function llm(): LlmProvider {
  if (override) return override;
  return isOfflineModel() ? offlineProvider : anthropicProvider;
}

export function modelName(tier: ModelTier): string {
  return isOfflineModel() ? OFFLINE_MODEL : modelFor(tier);
}
