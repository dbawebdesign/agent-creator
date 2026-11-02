/** Small, dependency-free text utilities shared by the offline model, Architect heuristics and retrieval. */

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren as at be because been before being below between both but by can " +
    "cannot could did do does doing don down during each few for from further had has have having he her here hers herself him himself his how " +
    "i if in into is isn it its itself just let like me more most my myself no nor not now of off on once only or other our ours ourselves out over own " +
    "really same she should so some such than that the their theirs them themselves then there these they this those through to too under until up " +
    "uh um us very was we were what when where which while who whom why will with would you your yours yourself yourselves yeah okay ok gonna kind " +
    "sort thing things stuff going get got make made want wants need needs know think say said mean actually basically literally pretty right " +
    "well way lot lots much many every everything something anything someone one two three us use used using task please today tomorrow week " +
    "weeks month day days time hour hours agent agents client clients business businesses customer customers people person"
  ).split(/\s+/),
);

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).map((w) => w.replace(/'s$/, "").replace(/['-]+$/, ""));
}

/** Top keywords by frequency (stopwords removed), stable order for determinism. */
export function keywords(text: string, max = 8): string[] {
  const counts = new Map<string, number>();
  for (const w of tokenize(text)) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?]["”')]?)\s+(?=[A-Z0-9"“])|\n{2,}/)
    .map((s) => normalizeWhitespace(s))
    .filter((s) => s.length > 0);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Rough token estimate (~4 chars/token) used for offline metering and budget math. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function slugify(s: string, max = 32): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "agent"
  );
}

/** Deterministic 32-bit FNV-1a hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Escape a value for a GFM table cell. */
export function cell(s: string): string {
  return normalizeWhitespace(s).replace(/\|/g, "\\|");
}
