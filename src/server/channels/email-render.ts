/**
 * Minimal, calm HTML + text email for deliverables and agent replies.
 *
 * Markdown is parsed with remark (GFM) → hast, then serialized by a strict allowlist serializer below: raw HTML
 * in the source is dropped, links must be absolute http/https/mailto, images are dropped (no tracking pixels),
 * and every text node / interpolated string is HTML-escaped. No React: this runs in the worker under the
 * react-server condition, where react-dom/server is unavailable.
 */
import "server-only";
import { markdownToText } from "./text";

export { markdownToText };

export type EmailBranding = { displayName?: string; accent?: string; logoUrl?: string; whiteLabel?: boolean };

const SAFE_HEX = /^#[0-9a-fA-F]{6}$/;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = {
  p: "margin:0 0 14px;line-height:1.6;",
  h: "margin:22px 0 10px;font-weight:600;line-height:1.3;color:#111827;",
  li: "margin:0 0 6px;line-height:1.6;",
  list: "margin:0 0 14px;padding-left:22px;",
  table: "border-collapse:collapse;width:100%;margin:0 0 16px;font-size:13px;",
  cell: "border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f3f4f6;border-radius:4px;padding:1px 4px;",
  pre: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f3f4f6;border-radius:6px;padding:12px;overflow:auto;margin:0 0 14px;white-space:pre-wrap;",
  quote: "margin:0 0 14px;padding:0 0 0 12px;border-left:3px solid #e5e7eb;color:#4b5563;",
  hr: "border:0;border-top:1px solid #e5e7eb;margin:20px 0;",
};

type HNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HNode[]; value?: string };

const BLOCK_STYLE: Record<string, string> = {
  p: STYLE.p,
  h1: `${STYLE.h}font-size:20px;`,
  h2: `${STYLE.h}font-size:17px;`,
  h3: `${STYLE.h}font-size:15px;`,
  h4: `${STYLE.h}font-size:14px;`,
  h5: `${STYLE.h}font-size:14px;`,
  h6: `${STYLE.h}font-size:14px;`,
  ul: STYLE.list,
  ol: STYLE.list,
  li: STYLE.li,
  table: STYLE.table,
  th: `${STYLE.cell}background:#f9fafb;font-weight:600;`,
  td: STYLE.cell,
  pre: STYLE.pre,
  blockquote: STYLE.quote,
  hr: STYLE.hr,
};
const PLAIN = new Set(["strong", "em", "del", "thead", "tbody", "tr", "br", "code"]);
const VOID = new Set(["hr", "br"]);
const DROP = new Set(["img", "input", "script", "style", "iframe", "object", "embed", "svg", "math"]);

function safeHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null; // relative links mean nothing in an inbox
  }
}

/** Serialize a (remark-rehype) hast tree with a strict tag/attribute allowlist and inline styles. */
function serialize(node: HNode, accent: string, inPre = false): string {
  if (node.type === "text") return escapeHtml(node.value ?? "");
  if (node.type === "root") return (node.children ?? []).map((c) => serialize(c, accent, inPre)).join("");
  if (node.type !== "element" || !node.tagName) return ""; // raw HTML, comments, doctype: dropped
  const tag = node.tagName.toLowerCase();
  if (DROP.has(tag)) return "";
  const inner = () => (node.children ?? []).map((c) => serialize(c, accent, inPre || tag === "pre")).join("");
  if (tag === "a") {
    const href = safeHref(node.properties?.href);
    return href
      ? `<a href="${escapeHtml(href)}" style="color:${accent};text-decoration:underline;" rel="noopener noreferrer">${inner()}</a>`
      : inner();
  }
  if (tag === "code" && !inPre) return `<code style="${STYLE.code}">${inner()}</code>`;
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    const out = { h1: "h2", h2: "h3", h3: "h4" }[tag];
    return `<${out} style="${BLOCK_STYLE[tag]}">${inner()}</${out}>`;
  }
  const style = BLOCK_STYLE[tag];
  if (style !== undefined || PLAIN.has(tag)) {
    const align = node.properties?.align;
    const extra = (tag === "th" || tag === "td") && (align === "left" || align === "right" || align === "center") ? `text-align:${align};` : "";
    const attr = style !== undefined ? ` style="${style}${extra}"` : "";
    if (VOID.has(tag)) return `<${tag}${attr}>`;
    return `<${tag}${attr}>${inner()}</${tag}>`;
  }
  return inner(); // unknown wrappers (sections, sup, div): keep the text, drop the element
}

/** Render markdown (GFM) to inline-styled, sanitized HTML for email. Raw HTML in the source is never rendered. */
export async function markdownToEmailHtml(markdown: string, accent: string): Promise<string> {
  try {
    const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkRehype }] = await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("remark-gfm"),
      import("remark-rehype"),
    ]);
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: false });
    const tree = await processor.run(processor.parse(markdown));
    return serialize(tree as unknown as HNode, accent);
  } catch {
    return markdown
      .split(/\n{2,}/)
      .map((para) => `<p style="${STYLE.p}">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
}

export type RenderedEmail = { html: string; text: string };

export async function renderEmail(input: {
  /** Shown as the heading (deliverables) — omit for conversational replies. */
  title?: string | null;
  preview?: string | null;
  markdown: string;
  agentName: string;
  agentRole?: string | null;
  orgName: string;
  portalUrl?: string | null;
  branding?: EmailBranding | null;
}): Promise<RenderedEmail> {
  const accent = input.branding?.accent && SAFE_HEX.test(input.branding.accent) ? input.branding.accent : "#4F46E5";
  const bodyHtml = await markdownToEmailHtml(input.markdown, accent);
  const preheader = input.preview ? escapeHtml(input.preview.slice(0, 200)) : "";
  const footerBrand = input.branding?.whiteLabel ? "" : ` · Sent with Roster`;
  const signature = `${escapeHtml(input.agentName)}${input.agentRole ? ` · ${escapeHtml(input.agentRole)}` : ""}`;
  const button = input.portalUrl
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(input.portalUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px;">View in portal</a></p>`
    : "";
  const title = input.title
    ? `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;font-weight:650;color:#111827;">${escapeHtml(input.title)}</h1>` +
      (input.preview ? `<p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.5;">${escapeHtml(input.preview)}</p>` : "")
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
<tr><td style="padding:28px 28px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;">
${title}${bodyHtml}${button}
<p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #f0f1f3;color:#6b7280;font-size:13px;">${signature}<br>${escapeHtml(input.orgName)}</p>
</td></tr></table>
<p style="margin:14px 0 0;color:#9ca3af;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Reply to this email to talk to ${escapeHtml(input.agentName)}${footerBrand}</p>
</td></tr></table></body></html>`;

  const textParts = [
    input.title ? input.title : null,
    input.preview && input.title ? input.preview : null,
    markdownToText(input.markdown),
    input.portalUrl ? `View in portal: ${input.portalUrl}` : null,
    `— ${input.agentName}${input.agentRole ? `, ${input.agentRole}` : ""}\n${input.orgName}`,
  ].filter(Boolean);
  return { html, text: textParts.join("\n\n") };
}
