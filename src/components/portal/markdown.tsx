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
      if (fenced || !line.trim() || next === undefined || !next.trim())
        return line;
      if (BLOCK.test(line) || BLOCK.test(next) || /\s{2}$/.test(line))
        return line;
      return `${line}  `;
    })
    .join("\n");
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Agents often open with the same heading the page already shows as its title ("November social pack ·
 * Four Corners Coffee" under "Four Corners — November social pack"). Drop that repeat, by word overlap.
 */
export function dropLeadingTitle(md: string, title?: string): string {
  if (!title) return md;
  const m = md.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*(?:\n|$)/);
  if (!m) return md;
  const words = (t: string) => new Set(norm(t).split(" ").filter(Boolean));
  const hw = words((m[1] ?? "").replace(/[*_`]/g, ""));
  const tw = words(title);
  if (!hw.size || !tw.size) return md;
  const inTitle = [...hw].filter((w) => tw.has(w)).length;
  const titleCovered =
    [...tw].every((w) => hw.has(w)) && hw.size - inTitle <= 2;
  const restates =
    inTitle === hw.size && hw.size >= Math.max(2, Math.ceil(tw.size * 0.6));
  if (!titleCovered && !restates) return md;
  return md.slice(m[0].length).replace(/^\s+/, "");
}

/** Safe markdown (no raw HTML, via the shared renderer) tuned for reading agent work. */
export function PortalMarkdown({
  children,
  className,
  title,
}: {
  children: string;
  className?: string;
  title?: string;
}) {
  return (
    <Markdown className={className}>
      {softBreaks(dropLeadingTitle(children, title))}
    </Markdown>
  );
}
