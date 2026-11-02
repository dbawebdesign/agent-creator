/** Security critique r3 M4 (ported proof): recipients match exact addresses, never substrings. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recipientProblem } from "@/server/agents/tools/recipients";
import { db } from "@/server/db/client";

const ctx = (task: string, sender: string | null = null) =>
  ({ db: db(), run: { id: randomUUID(), orgId: randomUUID(), input: { kind: "task", task } }, workflow: null, agent: { id: randomUUID() }, trust: { trusted: true, sender, participant: null } }) as never;

describe("recipientProblem", () => {
  it("refuses look-alikes that are substrings of an allowed address", async () => {
    const task = "Send the weekly numbers to john@acme.com.";
    expect(await recipientProblem(ctx(task), "email", "john@acme.com")).toBeNull();
    expect(await recipientProblem(ctx(task), "email", "JOHN@acme.com")).toBeNull();
    expect(await recipientProblem(ctx(task), "email", "n@acme.co")).not.toBeNull();
    expect(await recipientProblem(ctx(task), "email", "x@evil.example")).not.toBeNull();
    expect(await recipientProblem(ctx("Reply to the sender", "bob@client.com.au"), "email", "b@client.com")).not.toBeNull();
    expect(await recipientProblem(ctx("Reply to the sender", "Bob <bob@client.com.au>"), "email", "bob@client.com.au")).toBeNull();
  });

  it("a whole domain only when the task names the domain itself", async () => {
    expect(await recipientProblem(ctx("Send it to anyone on the team at acme.com."), "email", "jane@acme.com")).toBeNull();
    expect(await recipientProblem(ctx("Send it to john@acme.com."), "email", "jane@acme.com")).not.toBeNull();
  });
});
