/**
 * Read a request/response body as text with a hard byte cap, streaming — so an unauthenticated caller (or a
 * provider response) can't make us buffer an arbitrarily large body (e.g. chunked, no Content-Length).
 * Returns null when the cap is exceeded.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength?: string | null,
): Promise<string | null> {
  const bytes = await readBytesCapped(stream, maxBytes, declaredLength);
  return bytes === null ? null : bytes.toString("utf8");
}

/** Same as readStreamCapped, returning the raw bytes (multipart uploads, attachments). */
export async function readBytesCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength?: string | null,
): Promise<Buffer | null> {
  const declared = Number(declaredLength ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await stream?.cancel().catch(() => {});
    return null;
  }
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function readTextCapped(req: Request | Response, maxBytes: number): Promise<string | null> {
  return readStreamCapped(req.body, maxBytes, req.headers.get("content-length"));
}
