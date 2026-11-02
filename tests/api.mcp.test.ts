import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeDeliverable, makeOrg, makeWorkflow, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test" });
});

const engineMock = vi.hoisted(() => ({
  messageAgent: vi.fn(async () => ({
    conversationId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    reply: "Three quotes are pending; Acme is the biggest at $4,000.",
  })),
  runWorkflowNow: vi.fn(async () => ({ runId: "00000000-0000-4000-8000-000000000003" })),
}));
vi.mock("@/server/services/engine", () => engineMock);

import { createApiKey, type ApiScope } from "@/server/api/keys";
import { GET, POST } from "@/app/api/mcp/route";

const ALL: ApiScope[] = ["agents:read", "agents:invoke", "deliverables:read", "workflows:run"];

function rpc(key: string | null, body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", ...headers });
  if (key) h.set("authorization", `Bearer ${key}`);
  return POST(new Request("https://app.roster.test/api/mcp", { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

async function call(key: string, method: string, params?: unknown, id: number | string = 1) {
  const res = await rpc(key, { jsonrpc: "2.0", id, method, params });
  expect(res.status).toBe(200);
  return res.json();
}

async function setup() {
  const org = await makeOrg();
  const other = await makeOrg();
  const agent = await makeAgent(org.id);
  const otherAgent = await makeAgent(other.id);
  const wf = await makeWorkflow(org.id, agent.id);
  const d = await makeDeliverable(org.id, agent.id);
  const { key } = await createApiKey({ orgId: org.id, name: "Claude Desktop", scopes: ALL });
  return { org, other, agent, otherAgent, wf, d, key };
}

beforeEach(async () => {
  await truncateChannelTables();
  engineMock.messageAgent.mockClear();
});
afterAll(async () => {
  await cleanupOrgs();
});

describe("MCP transport", () => {
  it("requires a valid bearer key", async () => {
    const res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rpc("rk_live_bogus", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("GET is 405 (no SSE stream)", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });

  it("initialize negotiates the protocol version", async () => {
    const { key } = await setup();
    const r = await call(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "roster" } } });
    expect(typeof r.result.instructions).toBe("string");
    const older = await call(key, "initialize", { protocolVersion: "2024-11-05" });
    expect(older.result.protocolVersion).toBe("2024-11-05");
    const unknown = await call(key, "initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
  });

  it("acknowledges notifications with 202 and answers ping", async () => {
    const { key } = await setup();
    const res = await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(await call(key, "ping", undefined, "p1")).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
  });

  it("returns JSON-RPC errors for parse errors, invalid requests, unknown methods and bad protocol headers", async () => {
    const { key } = await setup();
    const parse = await rpc(key, "{not json");
    expect((await parse.json()).error.code).toBe(-32700);
    const invalid = await rpc(key, { jsonrpc: "1.0", id: 1, method: "ping" });
    expect((await invalid.json()).error.code).toBe(-32600);
    expect((await call(key, "does/not/exist")).error.code).toBe(-32601);
    const badHeader = await rpc(key, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2099-01-01" });
    expect(badHeader.status).toBe(400);
    const badOrigin = await rpc(key, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
    expect(badOrigin.status).toBe(403);
  });
});

describe("MCP tools", () => {
  it("lists the tools the key's scopes allow, with schemas", async () => {
    const { org, key } = await setup();
    const all = await call(key, "tools/list");
    const names = all.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_agents", "ask_agent", "list_deliverables", "get_deliverable", "run_workflow"]);
    for (const t of all.result.tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
    const { key: ro } = await createApiKey({ orgId: org.id, name: "ro", scopes: ["agents:read"] });
    const limited = await call(ro, "tools/list");
    expect(limited.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_agents"]);
    const denied = await call(ro, "tools/call", { name: "ask_agent", arguments: { agent_id: org.id, message: "hi" } });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("agents:invoke");
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
  });

  it("list_agents returns the org's agents with workflows", async () => {
    const { agent, wf, key } = await setup();
    const r = await call(key, "tools/call", { name: "list_agents", arguments: {} }, 7);
    expect(r.id).toBe(7);
    expect(r.result.isError).toBe(false);
    const data = JSON.parse(r.result.content[0].text);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]).toMatchObject({ id: agent.id, name: "Maya", workflows: [{ id: wf.id }] });
  });

  it("ask_agent calls the engine synchronously over the mcp channel", async () => {
    const { org, agent, key } = await setup();
    const r = await call(key, "tools/call", { name: "ask_agent", arguments: { agent_id: agent.id, message: "What's pending?" } });
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ reply: expect.stringContaining("Acme"), status: "completed" });
    expect(engineMock.messageAgent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: org.id, agentId: agent.id, channel: "mcp", wait: true, text: "What's pending?" }),
    );
  });

  it("validates tool arguments and reports unknown tools", async () => {
    const { key } = await setup();
    const missing = await call(key, "tools/call", { name: "ask_agent", arguments: { agent_id: "00000000-0000-4000-8000-000000000009" } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/Invalid arguments for ask_agent: message/);
    const badUuid = await call(key, "tools/call", { name: "get_deliverable", arguments: { deliverable_id: "1 or 1=1" } });
    expect(badUuid.result.isError).toBe(true);
    const extra = await call(key, "tools/call", { name: "list_agents", arguments: { org_id: "x" } });
    expect(extra.result.isError).toBe(true);
    const unknown = await call(key, "tools/call", { name: "delete_everything", arguments: {} });
    expect(unknown.error.code).toBe(-32602);
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
  });

  it("cannot reach another org's agent or deliverable", async () => {
    const { otherAgent, other, key } = await setup();
    const foreignD = await makeDeliverable(other.id, otherAgent.id, "secret");
    const ask = await call(key, "tools/call", { name: "ask_agent", arguments: { agent_id: otherAgent.id, message: "hi" } });
    expect(ask.result).toMatchObject({ isError: true, content: [{ text: "Agent not found." }] });
    const get = await call(key, "tools/call", { name: "get_deliverable", arguments: { deliverable_id: foreignD.id } });
    expect(get.result.isError).toBe(true);
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
  });

  it("list_deliverables / get_deliverable / run_workflow", async () => {
    const { d, wf, key } = await setup();
    const list = await call(key, "tools/call", { name: "list_deliverables", arguments: { limit: 5 } });
    const items = JSON.parse(list.result.content[0].text).deliverables;
    expect(items).toHaveLength(1);
    expect(items[0].body).toBeUndefined();
    const got = await call(key, "tools/call", { name: "get_deliverable", arguments: { deliverable_id: d.id } });
    expect(JSON.parse(got.result.content[0].text)).toMatchObject({ id: d.id, title: "Pipeline report" });
    const run = await call(key, "tools/call", { name: "run_workflow", arguments: { workflow_id: wf.id } });
    expect(JSON.parse(run.result.content[0].text)).toMatchObject({ workflowId: wf.id, status: "queued" });
  });
});
