"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Link back to the portal home for whatever /p/<slug> we're under. */
export function PortalHomeLink({ children, className }: { children: React.ReactNode; className?: string }) {
  const path = usePathname() ?? "/";
  const m = /^\/p\/([^/]+)/.exec(path);
  return (
    <Link href={m ? `/p/${m[1]}` : "/"} className={className}>
      {children}
    </Link>
  );
}
