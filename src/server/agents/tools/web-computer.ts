/** http_fetch (SSRF-guarded) and computer_* tools (behind the ComputerProvider interface). */
import { z } from "zod";
import { computerProvider, type ComputerAction } from "@/server/computer";
import { truncate } from "@/server/llm/text";
import { htmlToText, safeFetch, SsrfError, type LookupFn } from "@/server/security/ssrf";
import { defineTool, ok, toolError, type ToolContext } from "./types";

let lookupOverride: LookupFn | undefined;
/** Test hook: inject DNS resolution for http_fetch. */
export function setHttpFetchLookupForTests(fn: LookupFn | undefined) {
  lookupOverride = fn;
}

export const httpFetch = defineTool({
  name: "http_fetch",
  description: "Fetch a public https web page or JSON document (GET only) and return its text. Private/internal addresses are blocked.",
  schema: z.object({ url: z.string().url().max(2048) }),
  async run(input) {
    try {
      const res = await safeFetch(input.url, { lookup: lookupOverride, maxBytes: 1_000_000, timeoutMs: 10_000 });
      const isHtml = /html/i.test(res.contentType);
      const text = isHtml ? htmlToText(res.body) : res.body;
      return ok({ status: res.status, url: res.url, contentType: res.contentType, truncated: res.truncated, text: truncate(text, 15_000) });
    } catch (err) {
      if (err instanceof SsrfError) return toolError(`Blocked: ${err.message}`);
      return toolError(`Fetch failed: ${(err as Error).message}`);
    }
  },
});

async function act(ctx: ToolContext, action: ComputerAction) {
  if (!ctx.agent.computerId || ctx.agent.computerStatus !== "ready") return toolError("This agent's computer is not ready");
  const res = await computerProvider().act(ctx.agent.computerId, action);
  if (!res.ok) return toolError(res.error ?? "Computer action failed");
  return ok({ ok: true, text: res.text, screenshot: res.imageBase64 ? `[screenshot captured: ${res.imageBase64.length} bytes base64]` : undefined });
}

export const computerScreenshot = defineTool({
  name: "computer_screenshot",
  description: "Take a screenshot of your cloud computer's screen.",
  schema: z.object({}),
  run: (_i, ctx) => act(ctx, { type: "screenshot" }),
});

export const computerClick = defineTool({
  name: "computer_click",
  description: "Click at screen coordinates on your cloud computer.",
  schema: z.object({ x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000), button: z.enum(["left", "right"]).optional(), double: z.boolean().optional() }),
  run: (i, ctx) => act(ctx, { type: "click", x: i.x, y: i.y, button: i.button, double: i.double }),
});

export const computerType = defineTool({
  name: "computer_type",
  description: "Type text on your cloud computer.",
  schema: z.object({ text: z.string().min(1).max(5000) }),
  run: (i, ctx) => act(ctx, { type: "type", text: i.text }),
});

export const computerKey = defineTool({
  name: "computer_key",
  description: "Press a key or key combination on your cloud computer (e.g. Enter, ctrl+c).",
  schema: z.object({ key: z.string().min(1).max(40) }),
  run: (i, ctx) => act(ctx, { type: "key", key: i.key }),
});

export const computerBash = defineTool({
  name: "computer_bash",
  description: "Run a shell command on your cloud computer (sandboxed; not the Roster servers).",
  schema: z.object({ command: z.string().min(1).max(4000) }),
  approvalAction: () => "computer_bash",
  describe: (i) => `Run on the agent's computer: ${truncate(i.command, 200)}`,
  run: (i, ctx) => act(ctx, { type: "bash", command: i.command }),
});
