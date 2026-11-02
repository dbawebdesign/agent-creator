import { describe, expect, it } from "vitest";
import { buildCron, describeTrigger, humanizeCron, parseCadence } from "@/components/studio/cron";
import { extractItches, transcriptStats } from "@/components/studio/new-agent/reading";
import { estimateWeekly, fromDraft, toDraft } from "@/components/studio/new-agent/proposal";
import { agentSpec } from "@/server/agents/spec";

describe("plain-English schedules", () => {
  it("humanizes common crons", () => {
    expect(humanizeCron("0 6 * * 1-5")).toBe("Weekdays at 6:00 AM");
    expect(humanizeCron("30 6 * * 1-5")).toBe("Weekdays at 6:30 AM");
    expect(humanizeCron("0 15 * * 5")).toBe("Fridays at 3:00 PM");
    expect(humanizeCron("0 2 * * *")).toBe("Every day at 2:00 AM");
    expect(humanizeCron("0 9 1 * *")).toBe("Monthly on the 1st at 9:00 AM");
    expect(humanizeCron("0 12 * * 1,3,5")).toBe("Mon, Wed, Fri at 12:00 PM");
    expect(humanizeCron("0 * * * *")).toBe("Every hour");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });
  it("round-trips presets", () => {
    for (const cron of ["0 6 * * 1-5", "15 7 * * *", "0 9 * * 1", "0 8 3 * *", "5 * * * *"]) {
      const p = parseCadence(cron);
      expect(p.cadence).not.toBe("custom");
      expect(buildCron(p.cadence as Exclude<typeof p.cadence, "custom">, p.time, p.day)).toBe(cron);
    }
  });
  it("describes event and manual triggers", () => {
    expect(describeTrigger({ type: "event", event: "email.received" })).toBe("When an email arrives");
    expect(describeTrigger({ type: "manual" })).toBe("When asked");
  });
});

describe("Architect reading state", () => {
  const t = `AJ: Walk me through Monday.\n\nDana: Honestly, Monday starts Sunday night. I'm in my inbox at 9pm going through quote requests.\n\nAJ: How long does one take?\n\nDana: Forty minutes if the supplier sites cooperate.`;
  it("pulls the client's pain lines, not the host's questions", () => {
    const itches = extractItches(t);
    expect(itches.length).toBeGreaterThan(0);
    expect(itches.every((q) => !q.endsWith("?"))).toBe(true);
    expect(itches.join(" ")).toMatch(/Sunday night|Forty minutes/);
  });
  it("counts words and speakers", () => {
    expect(transcriptStats(t).speakers).toBe(2);
  });
});

describe("proposal draft", () => {
  const spec = agentSpec.parse({
    name: "Quinn",
    role: "Quoting Specialist",
    summary: "Quotes",
    instructions: "Draft quotes for every request with three options.",
    workflows: [
      { name: "Quote queue", instructions: "Draft every quote in the queue.", trigger: { type: "schedule", cron: "0 6 * * 1-5" }, hoursSavedPerRun: 2 },
      { name: "Friday status", instructions: "Send order status to clients.", trigger: { type: "schedule", cron: "0 15 * * 5" }, hoursSavedPerRun: 1 },
    ],
    firstDeliverable: { title: "Quotes", description: "All weekend quotes", instructions: "Do them" },
    weeklyHoursSaved: 11,
  });
  it("drops switched-off workflows and scales the weekly estimate", () => {
    const d = toDraft(spec);
    d.workflows[1]!._on = false;
    expect(estimateWeekly(d)).toBe(10);
    const out = fromDraft(d);
    expect(out.workflows).toHaveLength(1);
    expect(agentSpec.safeParse(out).success).toBe(true);
  });
});
