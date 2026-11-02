/** Security critique r3 L1–L3: note-leak overlap, single provisioning under double "Retry setup", no query params in logs. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { heuristicSpec } from "@/server/agents/architect";
import { sharesNoteText } from "@/server/agents/tools/recipients";
import { setComputerProviderForTests, type ComputerProvider } from "@/server/computer";
import { db, schema } from "@/server/db/client";
import { scrubDbParams } from "@/server/lib/logger";
import { hireAgent, provisionAgentComputer } from "@/server/services/engine";
import { makeOrgs, resetDb } from "./engine.helpers";

const PODCAST = readFileSync(path.join(__dirname, "fixtures", "podcast-ai-employees.md"), "utf8");

describe("L1: internal-note overlap", () => {
  const note = "Private: our margin on St. Luke's is thin, bump the price eight percent before it goes out to Greg.";
  it("catches any 8-word run, whatever the case, spacing or punctuation — not just the opening", () => {
    expect(sharesNoteText("Hi Greg, FYI the margin on St. Luke's is   thin, bump the price eight percent soon.", [note])).toBe(true);
    expect(sharesNoteText("Hi Greg, here is the revised schedule for next week.", [note])).toBe(false);
    expect(sharesNoteText("Never send St. Luke's a price directly — noted.", ["Never send St. Luke's a price directly"])).toBe(true);
  });
});

describe("L2: Retry setup twice provisions one computer", () => {
  afterEach(() => setComputerProviderForTests(null));

  it("only one concurrent caller provisions", async () => {
    await resetDb();
    const orgs = await makeOrgs();
    const spec = heuristicSpec({ transcript: PODCAST, orgName: orgs.client.name });
    const { agentId } = await hireAgent({ orgId: orgs.client.id, spec, actor: { type: "system" } });
    let calls = 0;
    const fake: ComputerProvider = {
      id: "orgo",
      configured: true,
      async provision() {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return { computerId: `pc-${calls}`, status: "ready" };
      },
      async status() {
        return "ready";
      },
      async act() {
        return { ok: true } as never;
      },
      async destroy() {},
    };
    setComputerProviderForTests(fake);
    await db().update(schema.agents).set({ computerId: null, computerStatus: "error" }).where(eq(schema.agents.id, agentId));
    await Promise.all([provisionAgentComputer({ orgId: orgs.client.id, agentId }), provisionAgentComputer({ orgId: orgs.client.id, agentId })]);
    expect(calls).toBe(1);
    const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(a).toMatchObject({ computerId: "pc-1", computerStatus: "ready" });
  });
});

describe("L3: logs carry no query values", () => {
  it("strips params from drizzle errors", () => {
    const msg = 'Failed query: insert into "messages" ("body","meta") values ($1, $2)\nparams: Hi Lorna,{"to":"lorna@baysidepeds.example"}';
    expect(scrubDbParams(msg)).toBe('Failed query: insert into "messages" ("body","meta") values ($1, $2)\nparams: [redacted]');
    expect(scrubDbParams(msg)).not.toContain("lorna@");
  });
});
