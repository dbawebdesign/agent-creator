/**
 * Agent computers (the 4th part of the agent stack). Pluggable provider:
 * - Orgo cloud computers when ORGO_API_KEY is set (HTTP adapter).
 * - Null provider otherwise: provisioning is a no-op and computer_* tools report "no computer attached".
 */
import { env } from "@/server/env";

export type ComputerAction =
  | { type: "screenshot" }
  | { type: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "bash"; command: string };

export type ComputerResult = { ok: boolean; text?: string; imageBase64?: string; error?: string };

export interface ComputerProvider {
  readonly id: "orgo" | "null";
  readonly configured: boolean;
  provision(input: { name: string }): Promise<{ computerId: string; status: "starting" | "ready" }>;
  status(computerId: string): Promise<"starting" | "ready" | "error">;
  act(computerId: string, action: ComputerAction): Promise<ComputerResult>;
  destroy(computerId: string): Promise<void>;
}

export const nullComputer: ComputerProvider = {
  id: "null",
  configured: false,
  async provision() {
    throw new Error("No computer provider is configured");
  },
  async status() {
    return "error";
  },
  async act() {
    return { ok: false, error: "This agent has no computer attached. Set ORGO_API_KEY to enable cloud computers." };
  },
  async destroy() {},
};

/** Orgo REST adapter. Base URL overridable with ORGO_API_URL. Secrets never logged. */
export function orgoComputer(apiKey: string, baseUrl = process.env.ORGO_API_URL ?? "https://www.orgo.ai/api"): ComputerProvider {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Orgo ${method} ${path.replace(/\/computers\/[^/]+/, "/computers/:id")} failed (${res.status})`);
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("json") ? await res.json() : { text: await res.text() }) as T;
  }
  const enc = encodeURIComponent;
  return {
    id: "orgo",
    configured: true,
    async provision({ name }) {
      const r = await call<{ id?: string; computer_id?: string; status?: string }>("POST", "/computers", { name, os: "linux" });
      const computerId = r.id ?? r.computer_id;
      if (!computerId) throw new Error("Orgo did not return a computer id");
      return { computerId, status: r.status === "running" || r.status === "ready" ? "ready" : "starting" };
    },
    async status(computerId) {
      const r = await call<{ status?: string }>("GET", `/computers/${enc(computerId)}`);
      return r.status === "running" || r.status === "ready" ? "ready" : r.status === "error" ? "error" : "starting";
    },
    async act(computerId, action) {
      try {
        const id = enc(computerId);
        switch (action.type) {
          case "screenshot": {
            const r = await call<{ image?: string; screenshot?: string }>("GET", `/computers/${id}/screenshot`);
            return { ok: true, imageBase64: r.image ?? r.screenshot };
          }
          case "click":
            await call("POST", `/computers/${id}/${action.double ? "double-click" : action.button === "right" ? "right-click" : "click"}`, { x: action.x, y: action.y });
            return { ok: true, text: `Clicked at (${action.x}, ${action.y})` };
          case "type":
            await call("POST", `/computers/${id}/type`, { text: action.text });
            return { ok: true, text: `Typed ${action.text.length} characters` };
          case "key":
            await call("POST", `/computers/${id}/key`, { key: action.key });
            return { ok: true, text: `Pressed ${action.key}` };
          case "scroll":
            await call("POST", `/computers/${id}/scroll`, { direction: action.direction, amount: action.amount ?? 3 });
            return { ok: true, text: `Scrolled ${action.direction}` };
          case "bash": {
            const r = await call<{ output?: string; text?: string }>("POST", `/computers/${id}/bash`, { command: action.command }, 120_000);
            return { ok: true, text: (r.output ?? r.text ?? "").slice(0, 20_000) };
          }
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    async destroy(computerId) {
      await call("DELETE", `/computers/${enc(computerId)}`);
    },
  };
}

let override: ComputerProvider | null = null;
export function setComputerProviderForTests(p: ComputerProvider | null) {
  override = p;
}

export function computerProvider(): ComputerProvider {
  if (override) return override;
  const key = env().ORGO_API_KEY;
  return key ? orgoComputer(key) : nullComputer;
}
