/** POST /api/orgs/[orgId]/knowledge/upload: auth, tenancy, validation, storage and indexing. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrgs, makeAgent, makeOrg, rid } from "./channels.fixtures";
import { makeDocx, makePdf } from "./api.files.fixtures";

vi.hoisted(() => {
  Object.assign(process.env, { APP_URL: "https://app.roster.test", EMAIL_DOMAIN: "agents.roster.test", AUTH_SECRET: "test-auth-secret" });
});

const session = vi.hoisted(() => ({ current: null as null | { id: string; isPlatformAdmin: boolean } }));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => session.current,
  requireUser: async () => session.current,
  clientIp: () => null,
}));

import { db, schema } from "@/server/db/client";
import { POST } from "@/app/api/orgs/[orgId]/knowledge/upload/route";
import { readFileBytes } from "@/server/files/service";

async function user(orgId: string, role: "owner" | "admin" | "member" | "viewer") {
  const [u] = await db().insert(schema.users).values({ email: `up-${rid()}@files.test` }).returning();
  await db().insert(schema.memberships).values({ userId: u!.id, orgId, role });
  return u!;
}

function upload(orgId: string, file: Blob | null, name: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (file) form.append("file", file, name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const req = new Request(`https://app.roster.test/api/orgs/${orgId}/knowledge/upload`, { method: "POST", body: form, headers });
  return POST(req, { params: Promise.resolve({ orgId }) });
}

beforeEach(async () => {
  session.current = null;
  await db().execute(sql`create unlogged table if not exists rate_limits (key text primary key, count integer not null, reset_at timestamptz not null)`);
  await db().execute(sql`delete from rate_limits where key like 'upload:%'`);
});
afterAll(async () => {
  await cleanupOrgs();
  await db().execute(sql`delete from users where email like 'up-%@files.test'`);
});

describe("knowledge upload route", () => {
  it("a member uploads a CSV for an agent: stored, indexed, linked", async () => {
    const org = await makeOrg();
    const agent = await makeAgent(org.id);
    const u = await user(org.id, "member");
    session.current = { id: u.id, isPlatformAdmin: false };
    const csv = "Name,Plan\nAcme,Pro\n";
    const res = await upload(org.id, new Blob([csv], { type: "text/csv" }), "customers.csv", { agentId: agent.id }, { origin: "https://app.roster.test" });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: { id: string; status: string; knowledgeSourceId: string; kind: string; duplicate: boolean } };
    expect(file).toMatchObject({ status: "indexed", kind: "csv", duplicate: false });

    const stored = await readFileBytes(org.id, file.id);
    expect(stored!.bytes.toString()).toBe(csv);
    expect(stored!.file).toMatchObject({ orgId: org.id, agentId: agent.id, uploadedBy: u.id, source: "upload", mime: "text/csv", size: csv.length, knowledgeSourceId: file.knowledgeSourceId });
    expect(await readFileBytes((await makeOrg()).id, file.id)).toBeNull(); // org-scoped read
    const [ks] = await db().select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, file.knowledgeSourceId));
    expect(ks).toMatchObject({ orgId: org.id, agentId: agent.id, title: "customers.csv" });
    const [a] = await db().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, org.id), eq(schema.auditLogs.action, "file.uploaded")));
    expect(a).toMatchObject({ actorType: "user", actorId: u.id, targetId: file.id });

    // Same bytes again → not indexed twice.
    const again = await upload(org.id, new Blob([csv]), "customers (1).csv", { agentId: agent.id });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { file: { duplicate: boolean; id: string } }).file).toMatchObject({ duplicate: true, id: file.id });
  });

  it("PDF and DOCX (org-wide, no agent)", async () => {
    const org = await makeOrg();
    const u = await user(org.id, "admin");
    session.current = { id: u.id, isPlatformAdmin: false };
    const pdf = await upload(org.id, new Blob([new Uint8Array(makePdf("Refunds within 30 days"))]), "policy.pdf");
    expect(pdf.status).toBe(201);
    const docx = await upload(org.id, new Blob([new Uint8Array(makeDocx(["Welcome kit ships day one"]))]), "onboarding.docx");
    expect(docx.status).toBe(201);
    const jobs = await db().select().from(schema.jobs).where(and(eq(schema.jobs.orgId, org.id), eq(schema.jobs.type, "knowledge.index")));
    const texts = jobs.map((j) => String((j.payload as { text: string }).text));
    expect(texts.some((t) => t.includes("Refunds within 30 days"))).toBe(true);
    expect(texts.some((t) => t.includes("Welcome kit ships day one"))).toBe(true);
  });

  it("auth and tenancy: 401 signed out, 404 for viewers, outsiders, other orgs' agents and bad ids", async () => {
    const org = await makeOrg();
    const other = await makeOrg();
    const otherAgent = await makeAgent(other.id);
    const csv = () => new Blob(["a,b\n1,2\n"]);
    expect((await upload(org.id, csv(), "a.csv")).status).toBe(401);
    const viewer = await user(org.id, "viewer");
    session.current = { id: viewer.id, isPlatformAdmin: false };
    expect((await upload(org.id, csv(), "a.csv")).status).toBe(404);
    const outsider = await user(other.id, "owner");
    session.current = { id: outsider.id, isPlatformAdmin: false };
    expect((await upload(org.id, csv(), "a.csv")).status).toBe(404);
    const m = await user(org.id, "member");
    session.current = { id: m.id, isPlatformAdmin: false };
    expect((await upload(org.id, csv(), "a.csv", { agentId: otherAgent.id })).status).toBe(404);
    expect((await upload("not-a-uuid", csv(), "a.csv")).status).toBe(404);
    expect((await upload(org.id, csv(), "a.csv", {}, { origin: "https://evil.test" })).status).toBe(404);
    expect(await db().select().from(schema.files).where(eq(schema.files.orgId, org.id))).toHaveLength(0);
  });

  it("validation: type, signature, size, empty, missing file, non-multipart", async () => {
    const org = await makeOrg();
    const m = await user(org.id, "member");
    session.current = { id: m.id, isPlatformAdmin: false };
    const err = async (r: Response) => ({ status: r.status, ...((await r.json()) as { error: { code: string; message: string } }).error });
    expect(await err(await upload(org.id, new Blob(["MZ"]), "tool.exe"))).toMatchObject({ status: 415, code: "unsupported_media_type" });
    expect(await err(await upload(org.id, new Blob(["<html>"]), "fake.pdf"))).toMatchObject({ status: 415, message: expect.stringContaining("PDF") });
    expect(await err(await upload(org.id, new Blob([new Uint8Array([0, 1, 2])]), "bin.txt"))).toMatchObject({ status: 415 });
    expect(await err(await upload(org.id, new Blob([]), "empty.txt"))).toMatchObject({ status: 400 });
    expect(await err(await upload(org.id, new Blob(["{bad"]), "x.json"))).toMatchObject({ status: 422 });
    expect(await err(await upload(org.id, null, "", { other: "x" }))).toMatchObject({ status: 400 });
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 100_000)]);
    expect(await err(await upload(org.id, big, "big.txt"))).toMatchObject({ status: 413 });
    const json = await POST(new Request(`https://app.roster.test/api/orgs/${org.id}/knowledge/upload`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), { params: Promise.resolve({ orgId: org.id }) });
    expect(json.status).toBe(415);
    expect(await db().select().from(schema.files).where(eq(schema.files.orgId, org.id))).toHaveLength(0);
  });
});
