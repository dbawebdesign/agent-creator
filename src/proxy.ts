/**
 * Custom domains → portal. A client (or reseller's customer) can point e.g. `team.brandlord.co` at Roster;
 * requests on that host are rewritten to `/p/<slug>/…`.
 *
 * A custom host is client-controlled (they own its DNS), so it serves ONLY that org's portal (security-r2 M3):
 *  - `/p/<its slug>/**` and bare paths → the portal; any other `/p/<slug>` → 404.
 *  - Studio, auth, onboarding, invites and API paths → redirected to APP_URL, so no session (agency staff
 *    or otherwise) is ever established on a host the client could later re-point.
 *  - Signed-out visitors hit the portal's login redirect, which lands on APP_URL and continues there.
 *
 * Kept cheap: app hosts short-circuit with no I/O; lookups are cached in-process (positive and negative,
 * bounded); only the Host header is trusted (never X-Forwarded-Host). Unknown hosts pass through unchanged.
 * Authorization still happens in the portal (requireOrg).
 */
import { NextResponse, type NextRequest } from "next/server";

const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Paths that belong to the app itself; on a custom host they're sent to APP_URL. */
const APP_ONLY =
  /^\/(a|api|invite|login|logout|signup|magic-link|onboarding|auth|admin)(\/|$)/;

const cache = new Map<string, { slug: string | null; at: number }>();
let poolPromise: Promise<import("pg").Pool> | null = null;

let appHostSet: Set<string> | null = null;
function appHosts(): Set<string> {
  if (appHostSet) return appHostSet;
  const set = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
  for (const raw of [
    process.env.APP_URL || "http://localhost:3000",
    ...(process.env.ROSTER_APP_HOSTS ?? "").split(","),
  ]) {
    if (!raw?.trim()) continue;
    try {
      set.add(
        new URL(
          raw.includes("://") ? raw : `https://${raw}`,
        ).hostname.toLowerCase(),
      );
    } catch {
      /* ignore malformed */
    }
  }
  appHostSet = set;
  return set;
}

async function pool() {
  poolPromise ??= import("pg").then(
    ({ default: pg }) =>
      new pg.Pool({
        connectionString:
          process.env.DATABASE_URL ??
          "postgres://roster:roster@localhost:5432/roster",
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 2_000,
        statement_timeout: 2_000,
        application_name: "roster-proxy",
      }),
  );
  return poolPromise;
}

async function slugForDomain(host: string): Promise<string | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.slug;
  const p = await pool();
  const res = await p.query<{ slug: string }>(
    "select slug from organizations where lower(custom_domain) = $1 and deleted_at is null and kind in ('client','customer') limit 1",
    [host],
  );
  const slug = res.rows[0]?.slug ?? null;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(host, { slug, at: Date.now() });
  return slug;
}

function appOrigin(): string | null {
  // Same default as src/server/env.ts.
  const raw = process.env.APP_URL || "http://localhost:3000";
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export async function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (
    !host ||
    appHosts().has(host) ||
    host.endsWith(".localhost") ||
    !HOST_RE.test(host)
  )
    return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (pathname.startsWith("/_next/")) return NextResponse.next();
  let slug: string | null;
  try {
    slug = await slugForDomain(host);
  } catch {
    // Lookup failed: never serve app paths on what may be a client host; let the portal paths 404 naturally.
    slug = null;
    if (APP_ONLY.test(pathname))
      return toApp(pathname, search) ?? NextResponse.next();
    return NextResponse.next();
  }
  if (!slug) return NextResponse.next();

  // Studio, auth and the rest of the app live on APP_URL only.
  if (APP_ONLY.test(pathname)) {
    return (
      toApp(pathname, search) ?? new NextResponse("Not found", { status: 404 })
    );
  }
  // The portal's own links are /p/<slug>/…: allow this org's, refuse anyone else's.
  if (pathname === "/p" || pathname.startsWith("/p/")) {
    const own = pathname === `/p/${slug}` || pathname.startsWith(`/p/${slug}/`);
    return own
      ? NextResponse.next()
      : new NextResponse("Not found", { status: 404 });
  }
  const url = req.nextUrl.clone();
  url.pathname = `/p/${slug}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url);
}

function toApp(pathname: string, search: string): NextResponse | null {
  const origin = appOrigin();
  if (!origin) return null;
  // 307 keeps the method, so a sign-out POST still signs out on the app host.
  return NextResponse.redirect(`${origin}${pathname}${search}`, 307);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
