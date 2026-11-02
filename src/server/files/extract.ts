/**
 * Server-side text extraction for knowledge uploads and email attachments.
 *
 * Every parser here is linear or bounded: CSV/TSV is a single-pass state machine, HTML reuses the
 * linear email scanner, PDF is capped by page count and wall time, and DOCX is checked for zip bombs
 * (declared uncompressed size and entry count) before mammoth inflates it.
 */
import { htmlToText, tidyWhitespace } from "@/server/channels/email";

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** engine.addKnowledge accepts ≤ 2,000,000 chars; leave headroom for the truncation note. */
export const MAX_EXTRACTED_CHARS = 1_900_000;
const PDF_MAX_PAGES = 500;
const PDF_TIMEOUT_MS = 20_000;
const DOCX_MAX_UNCOMPRESSED = 80 * 1024 * 1024;
const DOCX_MAX_ENTRIES = 5_000;
const CSV_MAX_ROWS = 100_000;
const CSV_MAX_COLS = 100;
const CSV_MAX_CELL = 2_000;
/** Each table block is one paragraph under the chunker's 1,200-char size, so every chunk keeps its header. */
const TABLE_BLOCK_CHARS = 1_000;

export type FileKind = "csv" | "tsv" | "txt" | "md" | "json" | "html" | "pdf" | "docx";

export const FILE_TYPES: Record<FileKind, { mime: string; label: string }> = {
  csv: { mime: "text/csv", label: "CSV" },
  tsv: { mime: "text/tab-separated-values", label: "TSV" },
  txt: { mime: "text/plain", label: "Text" },
  md: { mime: "text/markdown", label: "Markdown" },
  json: { mime: "application/json", label: "JSON" },
  html: { mime: "text/html", label: "HTML" },
  pdf: { mime: "application/pdf", label: "PDF" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word" },
};

const EXTENSIONS: Record<string, FileKind> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  json: "json",
  html: "html",
  htm: "html",
  pdf: "pdf",
  docx: "docx",
};

/** For the client: the accept= attribute and the list shown to people. */
export const ACCEPT_ATTR = ".csv,.tsv,.txt,.md,.json,.html,.htm,.pdf,.docx";

export class FileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 | 422 = 422,
  ) {
    super(message);
    this.name = "FileError";
  }
}

/** Filename without path parts or control characters, ≤ 200 chars (keeps the extension). */
export function safeFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  const name = base || "upload";
  if (name.length <= 200) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return name.slice(0, 200 - ext.length) + ext;
}

export function fileKind(name: string): FileKind | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4

function startsWith(bytes: Uint8Array, magic: number[], within = 0): boolean {
  outer: for (let off = 0; off <= within && off + magic.length <= bytes.length; off++) {
    for (let i = 0; i < magic.length; i++) if (bytes[off + i] !== magic[i]) continue outer;
    return true;
  }
  return false;
}

/** The bytes must match the extension: no executables renamed to .txt, no HTML renamed to .pdf. */
export function checkSignature(kind: FileKind, bytes: Uint8Array): void {
  if (kind === "pdf") {
    // The spec allows junk before the header; readers look in the first 1 KB.
    if (!startsWith(bytes, PDF_MAGIC, 1024)) throw new FileError("That file doesn't look like a PDF.", 415);
    return;
  }
  if (kind === "docx") {
    if (!startsWith(bytes, ZIP_MAGIC)) throw new FileError("That file doesn't look like a Word (.docx) document. Old .doc files aren't supported; save as .docx.", 415);
    return;
  }
  // Text formats: no NUL bytes in the first 8 KB (binary files nearly always have one).
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) throw new FileError("That file looks binary, not text.", 415);
}

/** UTF-8 (BOM stripped); falls back to Windows-1252, which is what Excel writes for "CSV". */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// --- CSV / TSV --------------------------------------------------------------------------------------

/** RFC 4180 parser (quotes, doubled quotes, CR/LF/CRLF) in one pass. Bounded rows/cols/cell length. */
export function parseDelimited(text: string, delimiter: "," | "\t"): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let cellLen = 0;
  let quoted = false;
  let truncated = false;
  const d = delimiter.charCodeAt(0);
  const pushCell = () => {
    if (row.length < CSV_MAX_COLS) row.push(cell);
    else truncated = true;
    cell = "";
    cellLen = 0;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  const add = (s: string) => {
    if (cellLen < CSV_MAX_CELL) {
      cell += s;
      cellLen += s.length;
    } else truncated = true;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (rows.length >= CSV_MAX_ROWS) {
      truncated = true;
      break;
    }
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          add('"');
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      // Copy the run up to the next quote in one slice.
      const next = text.indexOf('"', i);
      const end = next < 0 ? n : next;
      add(text.slice(i, Math.min(end, i + CSV_MAX_CELL)));
      if (end - i > CSV_MAX_CELL) truncated = true;
      i = end;
      continue;
    }
    if (c === 34 && cellLen === 0) {
      quoted = true;
      i++;
    } else if (c === d) {
      pushCell();
      i++;
    } else if (c === 10 || c === 13) {
      pushRow();
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    } else {
      add(text[i]!);
      i++;
    }
  }
  if (cell !== "" || row.length > 0) pushRow();
  return { rows, truncated };
}

function mdCell(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Rows → markdown tables. Output is split into blocks (blank-line separated) that each repeat the
 * header, so any retrieved chunk can be read on its own: "| Name | Plan | MRR |" stays with the row.
 */
export function tableToMarkdown(rows: string[][], caption: string): string {
  if (rows.length === 0) return "";
  const width = Math.min(CSV_MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const header = Array.from({ length: width }, (_, i) => mdCell(rows[0]![i] ?? "") || `Column ${i + 1}`);
  const head = `| ${header.join(" | ")} |\n|${header.map(() => " --- ").join("|")}|`;
  const body = rows.slice(1);
  if (body.length === 0) return `${caption} (header only)\n${head}`;
  const blocks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let first = 1;
  const flush = (last: number) => {
    if (cur.length === 0) return;
    blocks.push(`${caption}, rows ${first}–${last} of ${body.length}\n${head}\n${cur.join("\n")}`);
    cur = [];
    curLen = 0;
  };
  body.forEach((r, idx) => {
    const cells = Array.from({ length: width }, (_, i) => mdCell(r[i] ?? ""));
    const line = `| ${cells.join(" | ")} |`;
    if (head.length + line.length > TABLE_BLOCK_CHARS * 1.2) {
      // A row too wide for a table chunk: write it as "Header: value" lines instead.
      flush(idx);
      blocks.push(`${caption}, row ${idx + 1} of ${body.length}\n${cells.map((v, i) => `${header[i]}: ${v}`).join("\n")}`);
      first = idx + 2;
      return;
    }
    if (cur.length > 0 && head.length + curLen + line.length > TABLE_BLOCK_CHARS) {
      flush(idx);
      first = idx + 1;
    }
    cur.push(line);
    curLen += line.length + 1;
  });
  flush(body.length);
  return blocks.join("\n\n");
}

// --- DOCX zip-bomb guard ----------------------------------------------------------------------------

/** Read the zip central directory and refuse archives that declare too much (or hide sizes in ZIP64). */
export function checkZip(buf: Buffer): void {
  const minEocd = 22;
  if (buf.length < minEocd) throw new FileError("That Word document is damaged.", 422);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileError("That Word document is damaged.", 422);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff || entries > DOCX_MAX_ENTRIES) throw new FileError("That Word document is too large to read.", 413);
  if (cdOffset + cdSize > buf.length) throw new FileError("That Word document is damaged.", 422);
  let p = cdOffset;
  let total = 0;
  let hasDocument = false;
  for (let e = 0; e < entries; e++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FileError("That Word document is damaged.", 422);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (usize === 0xffffffff) throw new FileError("That Word document is too large to read.", 413);
    total += usize;
    if (total > DOCX_MAX_UNCOMPRESSED) throw new FileError("That Word document is too large to read.", 413);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === "word/document.xml") hasDocument = true;
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!hasDocument) throw new FileError("That file isn't a Word document.", 415);
}

// --- Entry point ------------------------------------------------------------------------------------

export type Extracted = { text: string; truncated: boolean; meta: Record<string, unknown> };

function withTimeout<T>(p: Promise<T>, msLimit: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FileError(`Reading the ${what} took too long.`, 422)), msLimit);
    }),
  ]);
}

function cap(text: string, truncated: boolean, meta: Record<string, unknown>): Extracted {
  const clean = text.trim();
  if (clean.length <= MAX_EXTRACTED_CHARS) return { text: clean, truncated, meta };
  return { text: `${clean.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Truncated: the file had more text than the knowledge base keeps.]`, truncated: true, meta };
}

export async function extractText(kind: FileKind, name: string, bytes: Buffer): Promise<Extracted> {
  checkSignature(kind, bytes);
  switch (kind) {
    case "csv":
    case "tsv": {
      const { rows, truncated } = parseDelimited(decodeText(bytes), kind === "csv" ? "," : "\t");
      if (rows.length === 0) throw new FileError("That file has no rows.", 422);
      return cap(tableToMarkdown(rows, name), truncated, { rows: Math.max(0, rows.length - 1), columns: rows[0]!.length });
    }
    case "txt":
    case "md":
      return cap(tidyWhitespace(decodeText(bytes).replace(/\r\n?/g, "\n")), false, {});
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(decodeText(bytes));
      } catch {
        throw new FileError("That file isn't valid JSON.", 422);
      }
      return cap(JSON.stringify(value, null, 2), false, {});
    }
    case "html":
      return cap(htmlToText(decodeText(bytes), { maxHtml: UPLOAD_MAX_BYTES, maxText: MAX_EXTRACTED_CHARS + 1 }), false, {});
    case "pdf": {
      const { getDocumentProxy } = await import("unpdf");
      const read = async () => {
        const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
        try {
          const pages = Math.min(pdf.numPages, PDF_MAX_PAGES);
          const parts: string[] = [];
          let length = 0;
          for (let n = 1; n <= pages && length <= MAX_EXTRACTED_CHARS; n++) {
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            let pageText = "";
            for (const item of content.items) {
              if (!("str" in item)) continue;
              pageText += item.str + (item.hasEOL ? "\n" : "");
            }
            page.cleanup();
            parts.push(tidyWhitespace(pageText).trim());
            length += pageText.length;
          }
          return { text: parts.filter(Boolean).join("\n\n"), pages: pdf.numPages, truncated: pdf.numPages > pages || length > MAX_EXTRACTED_CHARS };
        } finally {
          await pdf.destroy();
        }
      };
      let res: Awaited<ReturnType<typeof read>>;
      try {
        res = await withTimeout(read(), PDF_TIMEOUT_MS, "PDF");
      } catch (err) {
        if (err instanceof FileError) throw err;
        const msg = err instanceof Error ? err.name : "";
        throw new FileError(msg === "PasswordException" ? "That PDF is password-protected." : "That PDF couldn't be read.", 422);
      }
      if (!res.text.trim()) throw new FileError("That PDF has no selectable text (it may be a scan). Try a text PDF or paste the text.", 422);
      return cap(res.text, res.truncated, { pages: res.pages });
    }
    case "docx": {
      checkZip(bytes);
      const mammoth = (await import("mammoth")).default;
      let value: string;
      try {
        ({ value } = await withTimeout(mammoth.extractRawText({ buffer: bytes }), PDF_TIMEOUT_MS, "Word document"));
      } catch (err) {
        if (err instanceof FileError) throw err;
        throw new FileError("That Word document couldn't be read.", 422);
      }
      if (!value.trim()) throw new FileError("That Word document has no text.", 422);
      return cap(tidyWhitespace(value.replace(/\r\n?/g, "\n")), false, {});
    }
  }
}
