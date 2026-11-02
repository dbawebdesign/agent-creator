import { notFound } from "next/navigation";
import { FileText, Globe, Library, Mic, Type } from "lucide-react";
import { hasRole, requireOrg } from "@/server/auth/access";
import { agentKnowledge, getAgent } from "@/server/queries/studio";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { RelativeTime } from "@/components/shared/relative-time";
import { KnowledgeForm } from "@/components/studio/knowledge-form";
import { SectionHeading } from "@/components/studio/bits";

export const metadata = { title: "Knowledge" };
const ICON = { text: Type, url: Globe, file: FileText, transcript: Mic } as const;
const TONE = { ready: "good", indexing: "accent", pending: "neutral", failed: "bad" } as const;

export default async function KnowledgePage({ params }: { params: Promise<{ agency: string; agentId: string }> }) {
  const { agency: slug, agentId } = await params;
  const access = await requireOrg(slug, "viewer");
  const found = await getAgent(access.org.id, agentId);
  if (!found) notFound();
  const sources = await agentKnowledge(found.agent.orgId, found.agent.id);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-w-0">
        <SectionHeading title="Sources" count={sources.length} />
        {sources.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            {sources.map((s) => {
              const Icon = ICON[s.kind];
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink">{s.title}</p>
                    <p className="truncate text-[12px] text-ink-4">
                      {s.uri ? `${s.uri} · ` : ""}
                      {s.chunkCount ? `${s.chunkCount} chunks · ` : ""}
                      {s.agentId ? "" : "Shared with all agents · "}
                      <RelativeTime date={s.createdAt} />
                    </p>
                    {s.error ? <p className="mt-0.5 text-[12px] text-bad">{s.error}</p> : null}
                  </div>
                  <Badge tone={TONE[s.status]} dot>
                    {s.status === "ready" ? "Ready" : s.status === "indexing" ? "Indexing" : s.status === "pending" ? "Queued" : "Failed"}
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-line">
            <EmptyState icon={<Library />} title="No knowledge yet" body={`Add price sheets, policies and links so ${found.agent.name} answers from the source.`} />
          </div>
        )}
      </section>
      {hasRole(access, "member") ? (
        <section>
          <SectionHeading title="Add knowledge" />
          <KnowledgeForm agency={slug} agentId={found.agent.id} />
        </section>
      ) : null}
    </div>
  );
}
