/**
 * Knowledge base + memory retrieval.
 *
 * - Chunking: paragraph-aware, ~1,200 chars with overlap.
 * - Search: Postgres FTS over the generated `tsv` column (OR-of-terms tsquery ranked by ts_rank_cd); when
 *   VOYAGE_API_KEY is set, pgvector cosine search is fused in with reciprocal-rank fusion.
 * - Memory recall: FTS relevance + importance + recency.
 * Every query is scoped by org_id (and agent: own rows + org-shared rows where agent_id is null).
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { schema } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { keywords } from "@/server/llm/text";
import { embed, embeddingsEnabled } from "./embeddings";

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n/).flatMap((p) => (p.length > size ? hardSplit(p, size) : [p]));
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur.trim());
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      cur = `${tail.slice(tail.indexOf(" ") + 1)}\n\n${p}`;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.slice(0, 2000);
}

function hardSplit(p: string, size: number): string[] {
  const out: string[] = [];
  const sentences = p.split(/(?<=[.!?])\s+/);
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > size) {
      out.push(cur);
      cur = "";
    }
    if (s.length > size) {
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      continue;
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** (Re)index a source's text. Idempotent: replaces the source's chunks in one transaction. */
export async function indexText(database: DB, input: { orgId: string; sourceId: string; text: string }): Promise<number> {
  const source = (
    await database
      .select()
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.id, input.sourceId), eq(schema.knowledgeSources.orgId, input.orgId)))
      .limit(1)
  )[0];
  if (!source) throw new Error("Knowledge source not found");
  const chunks = chunkText(input.text);
  let vectors: number[][] | null = null;
  if (embeddingsEnabled() && chunks.length) {
    try {
      vectors = await embed(chunks, "document");
    } catch (err) {
      logger.warn({ err: (err as Error).message, sourceId: source.id }, "embedding failed; indexing with FTS only");
    }
  }
  await database.transaction(async (tx) => {
    await tx
      .delete(schema.knowledgeChunks)
      .where(and(eq(schema.knowledgeChunks.sourceId, source.id), eq(schema.knowledgeChunks.orgId, input.orgId)));
    for (let i = 0; i < chunks.length; i += 100) {
      const batch = chunks.slice(i, i + 100).map((content, j) => ({
        orgId: input.orgId,
        sourceId: source.id,
        agentId: source.agentId,
        seq: i + j,
        content,
        embedding: vectors?.[i + j] ?? null,
      }));
      if (batch.length) await tx.insert(schema.knowledgeChunks).values(batch);
    }
    await tx
      .update(schema.knowledgeSources)
      .set({ status: "ready", chunkCount: chunks.length, error: null })
      .where(and(eq(schema.knowledgeSources.id, source.id), eq(schema.knowledgeSources.orgId, input.orgId)));
  });
  return chunks.length;
}

/** OR-of-terms tsquery string from free text (sanitized: only [a-z0-9] lexemes). */
export function orTsQuery(text: string, max = 12): string | null {
  const terms = keywords(text, max)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 3);
  if (!terms.length) {
    const raw = (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, max);
    if (!raw.length) return null;
    return [...new Set(raw)].join(" | ");
  }
  return [...new Set(terms)].join(" | ");
}

export type KnowledgeHit = { id: string; sourceId: string; title: string; content: string; score: number };

export async function searchKnowledge(
  database: DB,
  input: { orgId: string; agentId: string | null; query: string; limit?: number },
): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const q = orTsQuery(input.query);
  const agentScope = input.agentId
    ? sql`(c.agent_id = ${input.agentId} or c.agent_id is null)`
    : sql`c.agent_id is null`;
  const fts: KnowledgeHit[] = q
    ? ((
        await database.execute(sql`
          select c.id, c.source_id as "sourceId", s.title, c.content,
                 ts_rank_cd(c.tsv, to_tsquery('english', ${q}), 32) as score
          from knowledge_chunks c
          join knowledge_sources s on s.id = c.source_id and s.org_id = c.org_id
          where c.org_id = ${input.orgId} and ${agentScope}
            and c.tsv @@ to_tsquery('english', ${q})
          order by score desc, c.seq asc
          limit ${limit * 2}`)
      ).rows as KnowledgeHit[])
    : [];
  if (!embeddingsEnabled()) return fts.slice(0, limit).map((h) => ({ ...h, score: Number(h.score) }));

  let vec: KnowledgeHit[] = [];
  try {
    const [qv] = await embed([input.query], "query");
    if (qv) {
      const literal = `[${qv.join(",")}]`;
      vec = (
        await database.execute(sql`
          select c.id, c.source_id as "sourceId", s.title, c.content, 1 - (c.embedding <=> ${literal}::vector) as score
          from knowledge_chunks c
          join knowledge_sources s on s.id = c.source_id and s.org_id = c.org_id
          where c.org_id = ${input.orgId} and ${agentScope} and c.embedding is not null
          order by c.embedding <=> ${literal}::vector
          limit ${limit * 2}`)
      ).rows as KnowledgeHit[];
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "vector search failed; using FTS only");
  }
  // Reciprocal-rank fusion.
  const fused = new Map<string, KnowledgeHit & { rrf: number }>();
  const addAll = (hits: KnowledgeHit[]) =>
    hits.forEach((h, rank) => {
      const prev = fused.get(h.id);
      const rrf = 1 / (60 + rank + 1);
      fused.set(h.id, prev ? { ...prev, rrf: prev.rrf + rrf } : { ...h, rrf });
    });
  addAll(fts);
  addAll(vec);
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ rrf, ...h }) => ({ ...h, score: rrf }));
}

export type MemoryHit = { id: string; kind: string; content: string; importance: number; score: number };

/** Recall memories by FTS relevance + importance + recency (and mark them recalled). */
export async function recallMemories(
  database: DB,
  input: { orgId: string; agentId: string; query?: string; limit?: number },
): Promise<MemoryHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 30);
  const q = input.query ? orTsQuery(input.query) : null;
  const rel = q ? sql`coalesce(ts_rank_cd(tsv, to_tsquery('english', ${q}), 32), 0)` : sql`0`;
  const rows = (
    await database.execute(sql`
      select id, kind, content, importance,
        (${rel} * 4
          + importance * 0.15
          + 1.0 / (1 + extract(epoch from (now() - coalesce(last_recalled_at, created_at))) / 86400 / 30)) as score
      from memories
      where org_id = ${input.orgId} and agent_id = ${input.agentId}
      order by score desc, created_at desc
      limit ${limit}`)
  ).rows as MemoryHit[];
  if (rows.length) {
    await database.execute(sql`
      update memories set last_recalled_at = now()
      where org_id = ${input.orgId} and agent_id = ${input.agentId}
        and id in (${sql.join(
          rows.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )})`);
  }
  return rows.map((r) => ({ ...r, score: Number(r.score), importance: Number(r.importance) }));
}

/** Job: knowledge.index — payload { orgId, sourceId, text?: string, url?: string }. */
export async function knowledgeIndexJob(database: DB, payload: Record<string, unknown>, fetchText: (url: string) => Promise<string>) {
  const orgId = String(payload.orgId ?? "");
  const sourceId = String(payload.sourceId ?? "");
  if (!orgId || !sourceId) throw new Error("knowledge.index: orgId and sourceId are required");
  await database
    .update(schema.knowledgeSources)
    .set({ status: "indexing" })
    .where(and(eq(schema.knowledgeSources.id, sourceId), eq(schema.knowledgeSources.orgId, orgId)));
  try {
    let text = typeof payload.text === "string" ? payload.text : "";
    if (!text && typeof payload.url === "string") text = await fetchText(payload.url);
    if (!text.trim()) throw new Error("No text to index");
    await indexText(database, { orgId, sourceId, text });
  } catch (err) {
    await database
      .update(schema.knowledgeSources)
      .set({ status: "failed", error: (err as Error).message.slice(0, 500) })
      .where(and(eq(schema.knowledgeSources.id, sourceId), eq(schema.knowledgeSources.orgId, orgId)));
    throw err;
  }
}

export { embeddingsEnabled };
