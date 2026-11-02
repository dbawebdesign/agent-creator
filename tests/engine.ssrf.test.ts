import { describe, expect, it } from "vitest";
import { isPublicIp, validateUrl, type LookupFn } from "@/server/security/ssrf";

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
