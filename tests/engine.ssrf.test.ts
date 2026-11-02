import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToText, isPublicIp, safeFetch, validateUrl, type LookupFn } from "@/server/security/ssrf";

const dns = (map: Record<string, string[]>): LookupFn => async (host) => {
  const addrs = map[host];
  if (!addrs) throw new Error("ENOTFOUND");
  return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "::ffff:169.254.169.254"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicIp(ip), ip).toBe(true);
  });

  it("blocks loopback, metadata and private targets after DNS resolution", async () => {
    const lookup = dns({
      "loop.example.com": ["127.0.0.1"],
      "meta.example.com": ["169.254.169.254"],
      "corp.example.com": ["10.0.0.7"],
      "mixed.example.com": ["93.184.215.14", "10.0.0.7"],
      "v6.example.com": ["::1"],
    });
    for (const url of [
      "https://loop.example.com/",
      "https://meta.example.com/latest/meta-data/",
      "https://corp.example.com/",
      "https://mixed.example.com/",
      "https://v6.example.com/",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://metadata.google.internal/",
      "http://example.com/",
      "https://example.com:8443/",
      "https://user:pass@example.com/",
      "file:///etc/passwd",
      "https://unresolvable.example.com/",
    ]) {
      await expect(validateUrl(url, lookup), url).rejects.toThrow();
    }
  });

  it("allows a public https host and pins the resolved address", async () => {
    const target = await validateUrl("https://catalog.example.com/products?page=2", dns({ "catalog.example.com": ["93.184.215.14"] }));
    expect(target.address).toBe("93.184.215.14");
    expect(target.url.pathname).toBe("/products");
  });
});

describe("htmlToText", () => {
  it("extracts readable text", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Hi &amp; welcome</p><script>alert(1)</script><!-- note --><div>Tumblers<br>$4.10 each</div></body></html>";
    expect(htmlToText(html)).toBe("Hi & welcome\n\nTumblers\n$4.10 each");
  });

  it("runs in linear time on hostile input (was 52 s on 200k '<')", () => {
    for (const evil of ["<".repeat(200_000), "<script".repeat(40_000), "<script>".repeat(40_000), "<!--".repeat(50_000), "<a ".repeat(100_000), "<p>".repeat(100_000), "\n \n".repeat(100_000)]) {
      const t = performance.now();
      htmlToText(evil);
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
});

describe("safeFetch limits", () => {
  afterEach(() => vi.restoreAllMocks());
  const publicDns = dns({ "slow.example.com": ["93.184.215.14"] });

  it("applies the overall deadline to DNS resolution", async () => {
    const hang: LookupFn = () => new Promise(() => undefined);
    const t = Date.now();
    await expect(safeFetch("https://slow.example.com/", { lookup: hang, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  /** Fake https.request whose response drips one byte every 50 ms forever (socket never idles). */
  function slowDrip(chunk = "x") {
    return vi.spyOn(https, "request").mockImplementation(((_opts: unknown, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/plain" } });
      let timer: NodeJS.Timeout | undefined;
      req.end = () => {
        cb(res);
        timer = setInterval(() => res.write(chunk), 50);
      };
      req.destroy = (e?: Error) => {
        clearInterval(timer);
        res.destroy();
        if (e) req.emit("error", e);
      };
      return req;
    }) as unknown as typeof https.request);
  }

  it("aborts a slow-drip body at the overall deadline", async () => {
    slowDrip();
    const t = Date.now();
    await expect(safeFetch("https://slow.example.com/", { lookup: publicDns, timeoutMs: 400 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("honours a caller abort signal", async () => {
    slowDrip();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(safeFetch("https://slow.example.com/", { lookup: publicDns, timeoutMs: 10_000, signal: ac.signal })).rejects.toThrow(/timed out/);
  });

  it("caps the body at maxBytes", async () => {
    slowDrip("y".repeat(400));
    const res = await safeFetch("https://slow.example.com/", { lookup: publicDns, timeoutMs: 5_000, maxBytes: 1_000 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(1_000);
  });
});
