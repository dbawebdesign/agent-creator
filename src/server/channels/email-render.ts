/**
 * Minimal, calm HTML + text email for deliverables and agent replies.
 *
 * Markdown is rendered with react-markdown (raw HTML in the source is NOT rendered; URLs are filtered to
 * http/https/mailto by its default urlTransform) into static markup, then styled inline for mail clients.
 * Every interpolated string is HTML-escaped.
 */
import "server-only";
import { createElement, type ReactNode } from "react";
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

/** Render markdown to inline-styled, sanitized HTML. */
export async function markdownToEmailHtml(markdown: string, accent: string): Promise<string> {
  try {
    const [{ default: Markdown }, { default: remarkGfm }, { renderToStaticMarkup }] = await Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      import("react-dom/server"),
    ]);
    const s = (style: string) => ({ style: Object.fromEntries(style.split(";").filter(Boolean).map((d) => {
      const [k, ...v] = d.split(":");
      return [k!.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v.join(":").trim()];
    })) });
    type P = { children?: ReactNode; href?: string };
    const el = (tag: string, style: string) => (props: P) => createElement(tag, s(style), props.children);
    const tree = createElement(
      Markdown,
      {
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        components: {
          p: el("p", STYLE.p),
          h1: el("h2", `${STYLE.h}font-size:20px;`),
          h2: el("h3", `${STYLE.h}font-size:17px;`),
          h3: el("h4", `${STYLE.h}font-size:15px;`),
          h4: el("h4", `${STYLE.h}font-size:14px;`),
          ul: el("ul", STYLE.list),
          ol: el("ol", STYLE.list),
          li: el("li", STYLE.li),
          table: el("table", STYLE.table),
          th: el("th", `${STYLE.cell}background:#f9fafb;font-weight:600;`),
          td: el("td", STYLE.cell),
          code: el("code", STYLE.code),
          pre: el("pre", STYLE.pre),
          blockquote: el("blockquote", STYLE.quote),
          hr: () => createElement("hr", s(STYLE.hr)),
          img: () => null,
          a: (props: P) =>
            createElement("a", { href: props.href, ...s(`color:${accent};text-decoration:underline;`), rel: "noopener noreferrer" }, props.children),
        },
      },
      markdown,
    );
    return renderToStaticMarkup(tree);
  } catch {
    // Fallback (e.g. a bundler that can't load react-dom/server): escaped paragraphs.
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
