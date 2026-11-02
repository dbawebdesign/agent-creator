import { describe, expect, it } from "vitest";
import { feedBucket, greeting, hoursPhrase, humanizeCron, humanizeTrigger } from "@/components/portal/lib";
import { softBreaks } from "@/components/portal/markdown";
import { resolveBrand } from "@/server/queries/portal";
import type { Org } from "@/server/auth/access";

describe("portal: plain-English schedules", () => {
  it.each([
    ["0 6 * * 1-5", "every weekday at 6 AM"],
    ["30 6 * * 1-5", "every weekday at 6:30 AM"],
    ["0 15 * * 5", "every Friday at 3 PM"],
    ["0 2 * * *", "every day at 2 AM"],
    ["0 9 1 * *", "on the 1st of every month at 9 AM"],
    ["*/15 * * * *", "every 15 minutes"],
    ["0 8 * * 1,3", "every Monday and Wednesday at 8 AM"],
    ["weird", "on a regular schedule"],
  ])("%s → %s", (cron, words) => expect(humanizeCron(cron)).toBe(words));

  it("describes events and manual triggers", () => {
    expect(humanizeTrigger({ type: "event", event: "email.received" })).toBe("whenever an email comes in");
    expect(humanizeTrigger({ type: "manual" })).toBe("whenever you ask");
  });
});

describe("portal: time words", () => {
  it("greets by the org's local time, not the server's", () => {
    const at = new Date("2026-11-02T13:00:00Z"); // 8 AM New York, 2 PM Berlin
    expect(greeting("America/New_York", at)).toBe("Good morning");
    expect(greeting("Europe/Berlin", at)).toBe("Good afternoon");
  });
  it("buckets the feed", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(feedBucket(new Date("2026-11-02T12:00:00Z"), "America/New_York", now)).toBe("This morning");
    expect(feedBucket(new Date("2026-11-01T12:00:00Z"), "America/New_York", now)).toBe("Yesterday");
  });
  it("rounds hours saved", () => {
    expect(hoursPhrase(0.4)).toBe("about 25 minutes");
    expect(hoursPhrase(10.75)).toBe("~11 hours");
    expect(hoursPhrase(0)).toBe("");
  });
});

describe("portal: markdown soft breaks", () => {
  it("keeps literal line breaks but leaves lists and tables alone", () => {
    expect(softBreaks("Best,\nMaya")).toBe("Best,  \nMaya");
    expect(softBreaks("- a\n- b")).toBe("- a\n- b");
    expect(softBreaks("| a |\n|---|\n| 1 |")).toBe("| a |\n|---|\n| 1 |");
    expect(softBreaks("```\nx\ny\n```")).toBe("```\nx\ny\n```");
  });
});

describe("portal: branding cascade", () => {
  const org = (o: Partial<Org>): Org =>
    ({ id: "x", parentId: null, agencyId: null, kind: "client", name: "Org", slug: "org", industry: null, website: null, timezone: "UTC", branding: {}, customDomain: null, status: "active", settings: {}, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...o }) as Org;
  const agency = org({ kind: "agency", name: "Northbeam AI", branding: { accent: "#4f46e5", displayName: "Northbeam", whiteLabel: true } });
  const client = org({ kind: "client", name: "Brandlord", branding: { accent: "#e11d48" } });
  const customer = org({ kind: "customer", name: "Four Corners", branding: {} });

  it("customers see their provider's brand", () => {
    const b = resolveBrand([customer, client, agency]);
    expect(b).toMatchObject({ name: "Brandlord", accent: "#e11d48", whiteLabel: true });
  });
  it("falls back field by field to the agency", () => {
    expect(resolveBrand([org({ name: "Harbor" }), agency])).toMatchObject({ name: "Harbor", accent: "#4f46e5" });
  });
  it("ignores unsafe values", () => {
    const b = resolveBrand([org({ branding: { accent: "red;}", logoUrl: "javascript:alert(1)" } })]);
    expect(b.accent).toBeNull();
    expect(b.logoUrl).toBeNull();
  });
});
