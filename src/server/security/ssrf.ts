/**
 * SSRF-guarded fetch for agent tools (http_fetch, URL knowledge sources).
 *
 * - https only, default port only, no credentials in the URL.
 * - Hostname is resolved first; EVERY resolved address must be public (blocks loopback, RFC1918, CGNAT,
 *   link-local incl. 169.254.169.254 metadata, multicast, reserved, IPv6 ULA/link-local, v4-mapped/NAT64 forms).
 * - The connection is pinned to the validated address (custom `lookup`), so DNS rebinding cannot swap it.
 * - Redirects are followed manually (max 3), each hop re-validated. Response size and total time are capped.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const BLOCKED_HOSTNAMES = /^(?:localhost|localhost\.localdomain|metadata|metadata\.google\.internal|instance-data)$|\.(?:localhost|local|internal|intranet|lan|home|corp)$/i;

const v4Block = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  v4Block.addSubnet(addr, prefix, "ipv4");
}
const v6Block = new net.BlockList();
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
  ["2001::", 23],
] as const) {
  v6Block.addSubnet(addr, prefix, "ipv6");
}

function embeddedV4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return mapped[1];
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (nat64?.[1]) return nat64[1];
  // Hex forms of mapped addresses, e.g. ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True when the IP is safe to connect to from the server (public unicast). */
export function isPublicIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !v4Block.check(ip, "ipv4") && ip !== "255.255.255.255";
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isPublicIp(v4);
    if (/^64:ff9b:/i.test(ip)) return false;
    return !v6Block.check(ip, "ipv6");
  }
  return false;
}

export type ValidatedTarget = { url: URL; address: string; family: number };

/** Validate a URL and resolve it to a single public address to connect to. */
export async function validateUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "https:") throw new SsrfError("Only https URLs are allowed");
  if (url.username || url.password) throw new SsrfError("Credentials in URLs are not allowed");
  if (url.port && url.port !== "443") throw new SsrfError("Only the default https port is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.test(host)) throw new SsrfError("Host is not allowed");
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new SsrfError("Address is not allowed");
    return { url, address: host, family: net.isIP(host) };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new SsrfError("Host could not be resolved");
  }
  if (!addrs.length) throw new SsrfError("Host could not be resolved");
  for (const a of addrs) if (!isPublicIp(a.address)) throw new SsrfError("Host resolves to a non-public address");
  const first = addrs[0]!;
  return { url, address: first.address, family: first.family };
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export type SafeFetchOptions = {
  lookup?: LookupFn;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
};

export type SafeFetchResult = { status: number; url: string; contentType: string; body: string; truncated: boolean };

/** GET a public https URL with SSRF protections and limits. */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let current = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const target = await validateUrl(current, opts.lookup);
    const res = await requestPinned(target, { maxBytes, deadline, headers: opts.headers ?? {} });
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, target.url).toString();
      continue;
    }
    return { status: res.status, url: target.url.toString(), contentType: res.contentType, body: res.body, truncated: res.truncated };
  }
  throw new SsrfError("Too many redirects");
}

function requestPinned(
  target: ValidatedTarget,
  o: { maxBytes: number; deadline: number; headers: Record<string, string> },
): Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const remaining = o.deadline - Date.now();
    if (remaining <= 0) return reject(new SsrfError("Request timed out"));
    const req = https.request(
      {
        protocol: "https:",
        hostname: target.url.hostname.replace(/^\[|\]$/g, ""),
        servername: net.isIP(target.url.hostname) ? undefined : target.url.hostname,
        port: 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        headers: { "user-agent": "RosterAgent/1.0 (+https://roster.ai)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5", ...o.headers },
        // Pin the socket to the address we validated (defeats DNS rebinding between check and connect).
        lookup: (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) =>
          cb(null, target.address, target.family),
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: String(res.headers.location), contentType, body: "", truncated: false });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > o.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
            res.destroy();
            resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated: true });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated }));
        res.on("error", (e) => (truncated ? undefined : reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new SsrfError("Request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Reduce HTML to readable text (scripts/styles removed, tags stripped, entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
