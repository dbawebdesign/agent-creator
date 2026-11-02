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

/** Safe markdown (no raw HTML, via the shared renderer) tuned for reading agent work. */
export function PortalMarkdown({ children, className }: { children: string; className?: string }) {
  return <Markdown className={className}>{softBreaks(children)}</Markdown>;
}
