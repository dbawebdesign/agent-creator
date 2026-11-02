import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeDeliverable, makeOrg, makeWorkflow, truncateChannelTables } from "./channels.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test" });
});

const engineMock = vi.hoisted(() => ({
  messageAgent: vi.fn(async (input: { wait?: boolean }) => ({
    conversationId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    reply: input.wait ? "Quote is $2,450." : undefined,
  })),
  runWorkflowNow: vi.fn(async () => ({ runId: "00000000-0000-4000-8000-000000000003" })),
}));
vi.mock("@/server/services/engine", () => engineMock);

import { db, schema } from "@/server/db/client";
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey, type ApiScope } from "@/server/api/keys";
import { sha256 } from "@/server/security/crypto";
import { GET as listAgentsRoute } from "@/app/api/v1/agents/route";
import { GET as getAgentRoute } from "@/app/api/v1/agents/[id]/route";
import { POST as messageRoute } from "@/app/api/v1/agents/[id]/messages/route";
import { GET as listDeliverablesRoute } from "@/app/api/v1/deliverables/route";
import { GET as getDeliverableRoute } from "@/app/api/v1/deliverables/[id]/route";
import { POST as runWorkflowRoute } from "@/app/api/v1/workflows/[id]/run/route";
import { GET as openapiRoute } from "@/app/api/v1/openapi.json/route";

const ALL: ApiScope[] = ["agents:read", "agents:invoke", "deliverables:read", "workflows:run"];
const BASE = "https://app.roster.test/api/v1";

function req(path: string, key: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function world() {
  const orgA = await makeOrg({ name: "Brandlord" });
  const orgB = await makeOrg({ name: "Other Co" });
  const agentA = await makeAgent(orgA.id, { name: "Maya" });
  const agentA2 = await makeAgent(orgA.id, { name: "Theo" });
  const agentB = await makeAgent(orgB.id, { name: "Bea" });
  const wfA = await makeWorkflow(orgA.id, agentA.id);
  const wfB = await makeWorkflow(orgB.id, agentB.id);
  const dA = await makeDeliverable(orgA.id, agentA.id, "A report");
  const dB = await makeDeliverable(orgB.id, agentB.id, "B report");
  const { key } = await createApiKey({ orgId: orgA.id, name: "Zapier", scopes: ALL });
  return { orgA, orgB, agentA, agentA2, agentB, wfA, wfB, dA, dB, key };
}

beforeEach(async () => {
  await truncateChannelTables();
  engineMock.messageAgent.mockClear();
  engineMock.runWorkflowNow.mockClear();
});
afterAll(async () => {
  await cleanupOrgs();
});

describe("API keys", () => {
  it("returns the raw key once, stores only its hash, and audits create/revoke", async () => {
    const org = await makeOrg();
    const { key, apiKey } = await createApiKey({ orgId: org.id, name: "CI", scopes: ["agents:read", "agents:read"] });
    expect(key).toMatch(/^rk_live_[A-Za-z0-9_-]{32}$/);
    expect(apiKey.prefix).toBe(key.slice(0, 12));
    expect(apiKey.scopes).toEqual(["agents:read"]);
    const [row] = await db().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    expect(row!.keyHash).toBe(sha256(key));
    expect(JSON.stringify(row)).not.toContain(key);
    const listed = await listApiKeys(org.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(JSON.stringify(listed)).not.toContain(row!.keyHash);

    await revokeApiKey(org.id, apiKey.id, { userId: null });
    const logs = await db().select().from(schema.auditLogs).where(eq(schema.auditLogs.orgId, org.id));
    expect(logs.map((l) => l.action).sort()).toEqual(["api_key.created", "api_key.revoked"]);
    expect(JSON.stringify(logs)).not.toContain(key);
    expect((await listApiKeys(org.id))[0]!.status).toBe("revoked");
  });

  it("rejects bad scopes and agents from another org; revoking another org's key is not found", async () => {
    const { orgA, orgB, agentB } = await world();
    await expect(createApiKey({ orgId: orgA.id, name: "x", scopes: ["admin:all" as ApiScope] })).rejects.toBeInstanceOf(ApiKeyError);
    await expect(createApiKey({ orgId: orgA.id, name: "x", scopes: ["agents:read"], agentId: agentB.id })).rejects.toThrow(/not found/i);
    const { apiKey } = await createApiKey({ orgId: orgB.id, name: "b", scopes: ["agents:read"] });
    await expect(revokeApiKey(orgA.id, apiKey.id)).rejects.toThrow(/not found/i);
    const [row] = await db().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    expect(row!.revokedAt).toBeNull();
  });
});

describe("REST v1 auth", () => {
  it("401s without a key, with a malformed key, and with an unknown key — with a consistent error shape", async () => {
    for (const k of [null, "nope", `rk_live_${"x".repeat(32)}`]) {
      const res = await listAgentsRoute(req("/agents", k), undefined);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("401s for revoked and expired keys", async () => {
    const org = await makeOrg();
    await makeAgent(org.id);
    const revoked = await createApiKey({ orgId: org.id, name: "r", scopes: ALL });
    await revokeApiKey(org.id, revoked.apiKey.id);
    expect((await listAgentsRoute(req("/agents", revoked.key), undefined)).status).toBe(401);
    const expired = await createApiKey({ orgId: org.id, name: "e", scopes: ALL });
    await db().update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiKeys.id, expired.apiKey.id));
    expect((await listAgentsRoute(req("/agents", expired.key), undefined)).status).toBe(401);
  });

  it("enforces scopes", async () => {
    const { orgA, agentA, wfA } = await world();
    const { key } = await createApiKey({ orgId: orgA.id, name: "ro", scopes: ["agents:read"] });
    expect((await listAgentsRoute(req("/agents", key), undefined)).status).toBe(200);
    const res = await listDeliverablesRoute(req("/deliverables", key), undefined);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_scope");
    const msg = await messageRoute(req(`/agents/${agentA.id}/messages`, key, { method: "POST", body: JSON.stringify({ text: "hi" }) }), params(agentA.id));
    expect(msg.status).toBe(403);
    expect((await runWorkflowRoute(req(`/workflows/${wfA.id}/run`, key, { method: "POST" }), params(wfA.id))).status).toBe(403);
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
    expect(engineMock.runWorkflowNow).not.toHaveBeenCalled();
  });

  it("rate limits per key with 429 + Retry-After", async () => {
    const org = await makeOrg();
    const { key, apiKey } = await createApiKey({ orgId: org.id, name: "rl", scopes: ALL });
    await db().execute(sql`insert into rate_limits (key, count, reset_at) values (${`api:key:${apiKey.id}`}, 120, now() + interval '60 seconds')
      on conflict (key) do update set count = 120, reset_at = now() + interval '60 seconds'`);
    const res = await listAgentsRoute(req("/agents", key), undefined);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect((await res.json()).error.code).toBe("rate_limited");
  });
});

describe("REST v1 tenancy", () => {
  it("only ever shows the key's own org; other orgs' ids are 404", async () => {
    const w = await world();
    const list = await (await listAgentsRoute(req("/agents", w.key), undefined)).json();
    expect(list.data.map((a: { name: string }) => a.name).sort()).toEqual(["Maya", "Theo"]);
    expect(list.data[0].email).toMatch(/@agents\.roster\.test$/);
    expect(JSON.stringify(list)).not.toContain("instructions");

    expect((await getAgentRoute(req(`/agents/${w.agentB.id}`, w.key), params(w.agentB.id))).status).toBe(404);
    expect((await getAgentRoute(req(`/agents/not-a-uuid`, w.key), params("not-a-uuid"))).status).toBe(404);
    expect((await getDeliverableRoute(req(`/deliverables/${w.dB.id}`, w.key), params(w.dB.id))).status).toBe(404);
    const run = await runWorkflowRoute(req(`/workflows/${w.wfB.id}/run`, w.key, { method: "POST" }), params(w.wfB.id));
    expect(run.status).toBe(404);
    const msg = await messageRoute(req(`/agents/${w.agentB.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "hi" }) }), params(w.agentB.id));
    expect(msg.status).toBe(404);
    const filtered = await (await listDeliverablesRoute(req(`/deliverables?agentId=${w.agentB.id}`, w.key), undefined)).json();
    expect(filtered.data).toEqual([]);
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
    expect(engineMock.runWorkflowNow).not.toHaveBeenCalled();

    const own = await getAgentRoute(req(`/agents/${w.agentA.id}`, w.key), params(w.agentA.id));
    const body = await own.json();
    expect(body.data.workflows.map((x: { id: string }) => x.id)).toEqual([w.wfA.id]);
  });

  it("a key pinned to one agent cannot see or use the others", async () => {
    const w = await world();
    const { key } = await createApiKey({ orgId: w.orgA.id, name: "pinned", scopes: ALL, agentId: w.agentA.id });
    const list = await (await listAgentsRoute(req("/agents", key), undefined)).json();
    expect(list.data.map((a: { id: string }) => a.id)).toEqual([w.agentA.id]);
    expect((await getAgentRoute(req(`/agents/${w.agentA2.id}`, key), params(w.agentA2.id))).status).toBe(404);
    const dA2 = await makeDeliverable(w.orgA.id, w.agentA2.id, "Theo's");
    expect((await getDeliverableRoute(req(`/deliverables/${dA2.id}`, key), params(dA2.id))).status).toBe(404);
    const all = await (await listDeliverablesRoute(req(`/deliverables`, key), undefined)).json();
    expect(all.data.map((d: { id: string }) => d.id)).toEqual([w.dA.id]);
  });

  it("rejects a conversationId from another org", async () => {
    const w = await world();
    const [conv] = await db().insert(schema.conversations).values({ orgId: w.orgB.id, agentId: w.agentB.id, channel: "api" }).returning();
    const res = await messageRoute(
      req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "hi", conversationId: conv!.id }) }),
      params(w.agentA.id),
    );
    expect(res.status).toBe(404);
    expect(engineMock.messageAgent).not.toHaveBeenCalled();
  });
});

describe("REST v1 operations", () => {
  it("messages an agent (sync and async) through the engine with an api_key actor", async () => {
    const w = await world();
    const sync = await messageRoute(
      req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "Quote 500 tumblers", wait: true }) }),
      params(w.agentA.id),
    );
    expect(sync.status).toBe(200);
    expect((await sync.json()).data).toMatchObject({ reply: "Quote is $2,450.", status: "completed" });
    const call = engineMock.messageAgent.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({ orgId: w.orgA.id, agentId: w.agentA.id, channel: "api", wait: true, actor: { type: "api_key" } });

    const queued = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "later" }) }), params(w.agentA.id));
    expect(queued.status).toBe(202);
    expect((await queued.json()).data).toMatchObject({ status: "queued", deliverables: [] });

    // `message` is an alias of `text` (matches MCP's ask_agent); conversation_id of conversationId.
    const alias = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ message: "Alias works", wait: true }) }), params(w.agentA.id));
    expect(alias.status).toBe(200);
    expect(engineMock.messageAgent.mock.calls.at(-1)![0]).toMatchObject({ text: "Alias works" });
    const none = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ wait: true }) }), params(w.agentA.id));
    expect(none.status).toBe(400);
    expect((await none.json()).error.message).toMatch(/text \(or message\)/);
  });

  it("validates bodies and refuses paused agents", async () => {
    const w = await world();
    const empty = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "  " }) }), params(w.agentA.id));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("invalid_request");
    const badJson = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: "{" }), params(w.agentA.id));
    expect(badJson.status).toBe(400);
    await db().update(schema.agents).set({ status: "paused" }).where(eq(schema.agents.id, w.agentA.id));
    const paused = await messageRoute(req(`/agents/${w.agentA.id}/messages`, w.key, { method: "POST", body: JSON.stringify({ text: "hi" }) }), params(w.agentA.id));
    expect(paused.status).toBe(409);
  });

  it("runs a workflow", async () => {
    const w = await world();
    const res = await runWorkflowRoute(req(`/workflows/${w.wfA.id}/run`, w.key, { method: "POST" }), params(w.wfA.id));
    expect(res.status).toBe(202);
    expect((await res.json()).data).toMatchObject({ workflowId: w.wfA.id, status: "queued" });
    expect(engineMock.runWorkflowNow).toHaveBeenCalledWith({ orgId: w.orgA.id, workflowId: w.wfA.id, actor: { type: "api_key", keyId: expect.any(String) } });
  });

  it("paginates deliverables with a stable cursor and filters by since", async () => {
    const w = await world();
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await makeDeliverable(w.orgA.id, w.agentA.id, `R${i}`, new Date(t0 - (i + 1) * 60_000));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const qs: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await listDeliverablesRoute(req(`/deliverables${qs}`, w.key), undefined);
      const body = await res.json();
      seen.push(...body.data.map((d: { id: string }) => d.id));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const since = new Date(t0 - 150_000).toISOString();
    const recent = await (await listDeliverablesRoute(req(`/deliverables?since=${encodeURIComponent(since)}`, w.key), undefined)).json();
    expect(recent.data).toHaveLength(3);
    expect(recent.data[0].portalUrl).toBe(`https://app.roster.test/p/${w.orgA.slug}/d/${recent.data[0].id}`);
    expect((await listDeliverablesRoute(req(`/deliverables?cursor=garbage`, w.key), undefined)).status).toBe(400);
    expect((await listDeliverablesRoute(req(`/deliverables?limit=1000`, w.key), undefined)).status).toBe(400);
  });

  it("serves an OpenAPI document", async () => {
    const res = await openapiRoute();
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(["/agents", "/agents/{id}", "/agents/{id}/messages", "/deliverables", "/deliverables/{id}", "/workflows/{id}/run"]);
    expect(doc.servers[0].url).toBe("https://app.roster.test/api/v1");
  });

  it("updates lastUsedAt on use", async () => {
    const org = await makeOrg();
    const { key, apiKey } = await createApiKey({ orgId: org.id, name: "lu", scopes: ALL });
    await listAgentsRoute(req("/agents", key), undefined);
    const [row] = await db().select().from(schema.apiKeys).where(and(eq(schema.apiKeys.id, apiKey.id)));
    expect(row!.lastUsedAt).not.toBeNull();
  });
});
