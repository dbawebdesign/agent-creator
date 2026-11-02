/** Voyage AI embeddings (optional). Only used when VOYAGE_API_KEY is set; 1024 dims (voyage-3). */
import { env } from "@/server/env";

export function embeddingsEnabled(): boolean {
  return Boolean(env().VOYAGE_API_KEY);
}

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const key = env().VOYAGE_API_KEY;
  if (!key) throw new Error("Embeddings are not configured");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: texts.slice(i, i + 64), model: "voyage-3", input_type: inputType }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Embedding request failed (${res.status})`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    for (const d of json.data ?? []) out.push(d.embedding);
  }
  return out;
}
