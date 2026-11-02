/** Quoted call excerpts and the "rules from the call" lines are context, not instructions (no DB, shared by the offline model and tools). */
export function withoutQuotedContext(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(?:\d+\.\s*)?(?:Hard rules from the call|Approval rule|Rules from the call)/i.test(l))
    .join("\n")
    .replace(/“[^”]*”/g, " ")
    .replace(/\n\nWhy this matters: [\s\S]*$/, "");
}

const NOT_NAMES = new Set(
  "a an the i we you please can could would will draft write reply send email text message tell let make put pull get find check and or but for to at of on in with from about re hi hello hey thanks monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december today tomorrow".split(
    " ",
  ),
);

/** People, companies and sites the task names ("Lorna Fitch", "Bayside", "SF-44821"). */
export function namedInTask(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][A-Za-z'’&.-]{1,}(?:\s+[A-Z][A-Za-z'’&.-]{1,}){0,3}/g)) {
    const words = m[0].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase().replace(/[’']s$/, "")));
    if (!words.length) continue;
    out.add(words.join(" ").replace(/[’']s$/, ""));
    for (const w of words) if (w.length >= 3) out.add(w.replace(/[’']s$/, ""));
  }
  for (const m of text.matchAll(/#?\b([A-Z]{2,}-?\d{3,})\b/g)) out.add(m[1]!);
  return [...out].filter((x) => x.length >= 3);
}

export function mentions(line: string, names: string[]): boolean {
  const l = line.toLowerCase();
  return names.some((n) => new RegExp(`(?:^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(l));
}

