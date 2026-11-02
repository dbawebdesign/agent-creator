/**
 * Custom domains → portal. A client (or reseller's customer) can point e.g. `team.brandlord.co` at Roster;
 * requests on that host are rewritten to `/p/<slug>/…`. Everything else passes straight through.
 *
 * Kept cheap and safe: app hosts short-circuit with no I/O; lookups are cached in-process (positive and
 * negative, bounded); only the Host header is trusted (never X-Forwarded-Host, which clients can forge);
 * any failure falls through to normal routing. Authorization still happens in the portal (requireOrg).
 */
import { NextResponse, type NextRequest } from "next/server";

const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PASSTHROUGH = /^\/(p|a|api|invite|login|logout|signup|magic-link|onboarding|_next)(\/|$)/;

const cache = new Map<string, { slug: string | null; at: number }>();
let poolPromise: Promise<import("pg").Pool> | null = null;

let appHostSet: Set<string> | null = null;
function appHosts(): Set<string> {
  if (appHostSet) return appHostSet;
  const set = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
  for (const raw of [process.env.APP_URL, ...(process.env.ROSTER_APP_HOSTS ?? "").split(",")]) {
    if (!raw?.trim()) continue;
    try {
      set.add(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase());
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
        connectionString: process.env.DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster",
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

export async function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!host || appHosts().has(host) || host.endsWith(".localhost") || !HOST_RE.test(host)) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PASSTHROUGH.test(pathname)) return NextResponse.next();
  try {
    const slug = await slugForDomain(host);
    if (!slug) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = `/p/${slug}${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.[a-zA-Z0-9]+$).*)"],
};
