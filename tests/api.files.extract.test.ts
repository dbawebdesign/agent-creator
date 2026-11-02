/** File ingestion: text extraction for every supported type, plus the hostile-input guards. */
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkSignature, extractText, fileKind, parseDelimited, safeFileName, tableToMarkdown, FileError } from "@/server/files/extract";

export function makePdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Minimal stored (uncompressed) zip. `fakeSize` overrides the declared uncompressed size of an entry. */
export function makeZip(entries: { name: string; data: string; fakeSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.fakeSize ?? data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function makeDocx(paragraphs: string[], extra: { name: string; data: string; fakeSize?: number }[] = []): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
    ...extra,
  ]);
}

describe("file kinds and names", () => {
  it("maps extensions and sanitizes names", () => {
    expect(fileKind("Report.PDF")).toBe("pdf");
    expect(fileKind("a.tab")).toBe("tsv");
    expect(fileKind("notes.markdown")).toBe("md");
    expect(fileKind("evil.exe")).toBeNull();
    expect(fileKind("noext")).toBeNull();
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\q3.csv")).toBe("q3.csv");
    expect(safeFileName("a\u202egpj.exe\u0000")).toBe("agpj.exe");
    const long = safeFileName("x".repeat(400) + ".docx");
    expect(long.length).toBe(200);
    expect(long.endsWith(".docx")).toBe(true);
  });

  it("checks magic bytes against the extension", () => {
    expect(() => checkSignature("pdf", Buffer.from("<html>not a pdf"))).toThrow(FileError);
    expect(() => checkSignature("docx", Buffer.from("%PDF-1.4"))).toThrow(/Word/);
    expect(() => checkSignature("txt", Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toThrow(/binary/);
    expect(() => checkSignature("pdf", makePdf("ok"))).not.toThrow();
  });
});

describe("CSV / TSV → markdown tables", () => {
  it("parses quotes, doubled quotes, CRLF and embedded newlines", () => {
    const { rows } = parseDelimited('Name,Note\r\n"Acme, Inc","said ""hi""\nthen left"\r\nBob,\n\n', ",");
    expect(rows).toEqual([
      ["Name", "Note"],
      ["Acme, Inc", 'said "hi"\nthen left'],
      ["Bob", ""],
    ]);
  });

  it("repeats the header in every block so each chunk stands alone", async () => {
    const csv = "Name,Plan,MRR\n" + Array.from({ length: 200 }, (_, i) => `Customer ${i},Pro|annual,${i * 10}`).join("\n");
    const out = await extractText("csv", "customers.csv", Buffer.from(csv));
    expect(out.meta).toEqual({ rows: 200, columns: 3 });
    const blocks = out.text.split("\n\n");
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      expect(b).toContain("| Name | Plan | MRR |");
      expect(b.length).toBeLessThan(1200); // under the knowledge chunk size
    }
    expect(blocks[0]).toMatch(/^customers\.csv, rows 1–\d+ of 200/);
    expect(out.text).toContain("| Customer 7 | Pro\\|annual | 70 |");
    expect(out.text).toContain("Customer 199");
  });

  it("TSV, BOM, Windows-1252 and blank headers", async () => {
    const tsv = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("SKU\t\tQty\nA1\tWidget\t3\n")]);
    const out = await extractText("tsv", "stock.tsv", tsv);
    expect(out.text).toContain("| SKU | Column 2 | Qty |");
    const latin = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9]); // "Name\nCafé" in cp1252
    expect((await extractText("csv", "x.csv", latin)).text).toContain("Café");
  });

  it("very wide rows become Header: value records", () => {
    const header = Array.from({ length: 40 }, (_, i) => `Field ${i}`);
    const row = header.map(() => "v".repeat(40));
    const md = tableToMarkdown([header, row], "wide.csv");
    expect(md).toContain("Field 39: " + "v".repeat(40));
  });

  it("hostile CSV stays linear", () => {
    const t = performance.now();
    parseDelimited('"'.repeat(2_000_000), ",");
    parseDelimited(",".repeat(2_000_000), ",");
    parseDelimited("\n".repeat(2_000_000), ",");
    parseDelimited(("a,".repeat(500) + "\n").repeat(2000), ",");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("other formats", () => {
  it("txt / md / json / html", async () => {
    expect((await extractText("txt", "a.txt", Buffer.from("Hello   \r\n\r\n\r\n\r\nWorld"))).text).toBe("Hello\n\nWorld");
    expect((await extractText("md", "a.md", Buffer.from("# Refunds\n\n30 days."))).text).toBe("# Refunds\n\n30 days.");
    expect((await extractText("json", "a.json", Buffer.from('{"plan":"pro","seats":3}'))).text).toBe('{\n  "plan": "pro",\n  "seats": 3\n}');
    await expect(extractText("json", "a.json", Buffer.from("{nope"))).rejects.toThrow(/valid JSON/);
    expect((await extractText("html", "a.html", Buffer.from("<h1>FAQ</h1><script>x()</script><p>Ship in 2 days</p>"))).text).toBe("FAQ\n\nShip in 2 days");
  });

  it("pdf", async () => {
    const out = await extractText("pdf", "policy.pdf", makePdf("Refund window is 30 days"));
    expect(out.text).toContain("Refund window is 30 days");
    expect(out.meta).toEqual({ pages: 1 });
    await expect(extractText("pdf", "x.pdf", Buffer.from("%PDF-1.4\ngarbage"))).rejects.toThrow(FileError);
  });

  it("docx, and zip bombs are refused before inflating", async () => {
    const out = await extractText("docx", "onboarding.docx", makeDocx(["Onboarding checklist", "Step two: send the welcome kit."]));
    expect(out.text).toContain("Onboarding checklist");
    expect(out.text).toContain("Step two: send the welcome kit.");
    await expect(extractText("docx", "bomb.docx", makeDocx(["x"], [{ name: "word/media/big.bin", data: "0", fakeSize: 200 * 1024 * 1024 }]))).rejects.toThrow(/too large/);
    await expect(extractText("docx", "z.docx", makeZip([{ name: "hello.txt", data: "hi" }]))).rejects.toThrow(/isn't a Word document/);
    await expect(extractText("docx", "z.docx", Buffer.from("PK\u0003\u0004 truncated"))).rejects.toThrow(/damaged/);
  });
});
