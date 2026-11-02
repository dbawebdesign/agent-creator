import { Markdown } from "@/components/shared/markdown";

const BLOCK = /^\s*(\||[-*+] |\d+[.)] |#|>|```|~~~)/;

/**
 * Agents often write single line breaks they mean literally ("Best,\nMaya", "To: …\nSubject: …").
 * Turn those into Markdown hard breaks, leaving lists, tables, headings, quotes and code untouched.
 */
export function softBreaks(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  return lines
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const next = lines[i + 1];
      if (fenced || !line.trim() || next === undefined || !next.trim()) return line;
      if (BLOCK.test(line) || BLOCK.test(next) || /\s{2}$/.test(line)) return line;
      return `${line}  `;
    })
    .join("\n");
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Agents often open with the same heading the page already shows as its title. Drop that repeat. */
export function dropLeadingTitle(md: string, title?: string): string {
  if (!title) return md;
  const m = md.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*(?:\n|$)/);
  if (!m) return md;
  const h = norm((m[1] ?? "").replace(/[*_`]/g, ""));
  const t = norm(title);
  if (!h || (h !== t && !t.endsWith(h) && !h.endsWith(t))) return md;
  return md.slice(m[0].length).replace(/^\s+/, "");
}

/** Safe markdown (no raw HTML, via the shared renderer) tuned for reading agent work. */
export function PortalMarkdown({ children, className, title }: { children: string; className?: string; title?: string }) {
  return <Markdown className={className}>{softBreaks(dropLeadingTitle(children, title))}</Markdown>;
}
