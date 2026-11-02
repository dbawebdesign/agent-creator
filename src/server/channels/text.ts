/** Pure text transforms shared by channels (no server/react imports — safe anywhere). */

const MAX_INPUT = 100_000;

// All quantifiers below are bounded (and never span newlines from a ^ anchor) so worst-case work is linear in
// input size — no catastrophic backtracking on hostile text echoed by an agent.

/** Markdown → readable plain text (for the text/plain part and SMS). */
export function markdownToText(input: string): string {
  return input
    .slice(0, MAX_INPUT)
    .replace(/```[a-z]{0,20}\n?/gi, "")
    .replace(/!\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, "$1")
    .replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g, "$1 ($2)")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/(\*\*|__)([^\n]{1,500}?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]{1,500})\*/g, "$1$2")
    .replace(/`([^`\n]{1,500})`/g, "$1")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^\|?[ \t]*:?-{3,}[^\n]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/** Markdown → Slack mrkdwn (escapes &, <, > as Slack requires). */
export function markdownToSlack(input: string): string {
  const md = input.slice(0, MAX_INPUT);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const links: string[] = [];
  let s = md.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]{1,2000})\)/g, (_m, label: string, url: string) => {
    links.push(`<${url.replace(/[<>|]/g, "")}|${esc(label).replace(/\|/g, "/")}>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/^#{1,6}[ \t]+([^\n]{1,500})$/gm, "*$1*")
    .replace(/(\*\*|__)([^\n]{1,500}?)\1/g, "*$2*")
    .replace(/~~([^\n]{1,500}?)~~/g, "~$1~")
    .replace(/^[ \t]*[-+][ \t]+/gm, "• ")
    .replace(/^[ \t]*\*[ \t]+/gm, "• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "").trim();
}
