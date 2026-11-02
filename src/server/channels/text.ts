/** Pure text transforms shared by channels (no server/react imports — safe anywhere). */

/** Markdown → readable plain text (for the text/plain part and SMS). */
export function markdownToText(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\|?\s*:?-{3,}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/** Markdown → Slack mrkdwn (escapes &, <, > as Slack requires). */
export function markdownToSlack(md: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const links: string[] = [];
  let s = md.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<${url.replace(/[<>|]/g, "")}|${esc(label).replace(/\|/g, "/")}>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/(\*\*|__)(.+?)\1/g, "*$2*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^\s*[-+]\s+/gm, "• ")
    .replace(/^\s*\*\s+/gm, "• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "").trim();
}
