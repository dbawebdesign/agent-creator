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
  /** Caller cancellation (e.g. the run's own deadline); combined with timeoutMs. */
  signal?: AbortSignal;
};

export type SafeFetchResult = { status: number; url: string; contentType: string; body: string; truncated: boolean };

/** GET a public https URL with SSRF protections and limits. */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = Math.min(opts.maxBytes ?? 1_000_000, 5_000_000);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  // One overall deadline for DNS + every redirect hop + the whole body (not just socket idle time).
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let current = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const target = await withSignal(validateUrl(current, opts.lookup), signal);
    const res = await requestPinned(target, { maxBytes, deadline, headers: opts.headers ?? {}, signal });
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, target.url).toString();
      continue;
    }
    return { status: res.status, url: target.url.toString(), contentType: res.contentType, body: res.body, truncated: res.truncated };
  }
  throw new SsrfError("Too many redirects");
}

function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SsrfError("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SsrfError("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

type PinnedResult = { status: number; location?: string; contentType: string; body: string; truncated: boolean };

function requestPinned(target: ValidatedTarget, o: { maxBytes: number; deadline: number; headers: Record<string, string>; signal: AbortSignal }): Promise<PinnedResult> {
  return new Promise((rawResolve, rawReject) => {
    const remaining = o.deadline - Date.now();
    if (remaining <= 0 || o.signal.aborted) return rawReject(new SsrfError("Request timed out"));
    let settled = false;
    const cleanup = () => {
      settled = true;
      o.signal.removeEventListener("abort", onAbort);
    };
    const resolve = (v: PinnedResult) => {
      if (settled) return;
      cleanup();
      rawResolve(v);
    };
    const reject = (e: unknown) => {
      if (settled) return;
      cleanup();
      rawReject(e);
    };
    // Overall deadline: a slow-drip server cannot hold the request open past it.
    const onAbort = () => {
      const err = new SsrfError("Request timed out");
      reject(err);
      req.destroy(err);
    };
    o.signal.addEventListener("abort", onAbort, { once: true });
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
        res.on("close", () => (truncated ? undefined : reject(new SsrfError("Connection closed before the response finished"))));
      },
    );
    req.on("timeout", () => req.destroy(new SsrfError("Request timed out")));
    req.on("error", reject);
    req.end();
  });
}

const HTML_MAX_CHARS = 1_000_000;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
const BREAK_TAGS = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "section", "article", "header", "footer", "blockquote", "pre", "hr"]);
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", apos: "'" };

/**
 * Reduce HTML to readable text (scripts/styles removed, tags stripped, entities decoded).
 * Single forward scan with indexOf (linear time, no backtracking regexes), input capped at 1M chars.
 */
export function htmlToText(input: string): string {
  const html = input.length > HTML_MAX_CHARS ? input.slice(0, HTML_MAX_CHARS) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const endComment = html.indexOf("-->", lt + 4);
      i = endComment === -1 ? html.length : endComment + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // unterminated tag: drop the rest
    let j = lt + 1;
    if (html[j] === "/") j++;
    let k = j;
    while (k < gt && k - j < 32 && /[a-z0-9-]/i.test(html[k]!)) k++;
    const name = lower.slice(j, k);
    const closing = html[lt + 1] === "/";
    if (!closing && SKIP_TAGS.has(name) && html[gt - 1] !== "/") {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
      out.push(" ");
      i = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    out.push(BREAK_TAGS.has(name) ? "\n" : " ");
    i = gt + 1;
  }
  const text = out.join("").replace(/&(nbsp|amp|lt|gt|quot|#39|#x27|apos);/g, (_m, e: string) => ENTITIES[e] ?? " ");
  const lines: string[] = [];
  let blank = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t\r\f\v]+/g, " ").trim();
    if (!line) {
      blank = lines.length > 0;
      continue;
    }
    if (blank) lines.push("");
    blank = false;
    lines.push(line);
  }
  return lines.join("\n");
}
