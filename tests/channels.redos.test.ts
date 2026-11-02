/** Regression: hostile inbound content must parse in linear time (security critique r1 #2). */
import { describe, expect, it } from "vitest";
import { htmlToText, normalizeSubject, parseAddress, parseMessageIds, stripQuotedReply } from "@/server/channels/email";
import { markdownToSlack, markdownToText } from "@/server/channels/text";
import { segmentSms } from "@/server/channels/sms";

function ms(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const BUDGET = 250; // ms; the vulnerable versions took 7–50 s on these inputs

describe("linear-time parsing of hostile input", () => {
  it("htmlToText", () => {
    expect(ms(() => htmlToText("<".repeat(1_000_000)))).toBeLessThan(BUDGET);
    expect(ms(() => htmlToText("<script".repeat(200_000)))).toBeLessThan(BUDGET);
    expect(ms(() => htmlToText("<style>".repeat(100_000)))).toBeLessThan(BUDGET);
    expect(ms(() => htmlToText("<a ".repeat(300_000)))).toBeLessThan(BUDGET);
    expect(ms(() => htmlToText("<b>x</b>".repeat(200_000)))).toBeLessThan(BUDGET * 2);
    expect(htmlToText("<p>Hi&nbsp;<b>Maya</b></p><script>evil()</script><div>Thanks &amp; bye</div>")).toBe("Hi Maya\n\nThanks & bye");
    expect(htmlToText("<head><title>x</title></head>ok<script")).toBe("ok");
  });

  it("parseAddress and friends", () => {
    expect(ms(() => parseAddress("a" + " ".repeat(40_000) + "b"))).toBeLessThan(BUDGET);
    expect(ms(() => parseAddress('"' + " ".repeat(400) + "<a@b.co>"))).toBeLessThan(BUDGET);
    expect(parseAddress('"Dana Brand" <Dana@Brandlord.co>')).toEqual({ name: "Dana Brand", email: "dana@brandlord.co" });
    expect(parseAddress("Dana <dana@brandlord.co>")).toEqual({ name: "Dana", email: "dana@brandlord.co" });
    expect(parseAddress("dana@brandlord.co")).toEqual({ name: null, email: "dana@brandlord.co" });
    expect(parseAddress("Evil <a@b.co> <c@d.co>")).toBeNull();
    expect(ms(() => parseMessageIds("<".repeat(500_000)))).toBeLessThan(BUDGET);
    expect(ms(() => normalizeSubject("re:" + " ".repeat(100_000) + "x"))).toBeLessThan(BUDGET);
    expect(ms(() => stripQuotedReply(("On " + "x".repeat(150) + "\n").repeat(6000)))).toBeLessThan(BUDGET);
  });

  it("markdown transforms", () => {
    for (const evil of ["[".repeat(200_000), "**".repeat(200_000), "\n".repeat(200_000) + "x", "~~".repeat(100_000), "![".repeat(100_000)]) {
      expect(ms(() => markdownToText(evil))).toBeLessThan(BUDGET);
      expect(ms(() => markdownToSlack(evil))).toBeLessThan(BUDGET);
      expect(ms(() => segmentSms(evil))).toBeLessThan(BUDGET * 2);
    }
  });
});
