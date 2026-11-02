import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { PortalMarkdown as Markdown } from "@/components/portal/markdown";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Badge } from "@/components/ui/badge";
import { AskComposer } from "@/components/portal/composer";
import { ChannelIcon, KindIcon, kindLabel } from "@/components/portal/icons";
import { CHANNEL_LABEL, clockTime, hoursPhrase, longDate } from "@/components/portal/lib";
import { ReviewPanel } from "@/components/portal/review-panel";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { getDeliverable, getPortal } from "@/server/queries/portal";
import * as engine from "@/server/services/engine";

export async function generateMetadata({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const p = await getPortal(org);
  const d = await getDeliverable(p.org.id, id);
  return { title: d?.title ?? "Delivery" };
}

/** Opening a delivery marks it seen (only for the business's own people, not agency staff peeking in). */
async function markSeen(orgId: string, deliverableId: string, userId: string) {
  try {
    await engine.reviewDeliverable({ orgId, deliverableId, action: "seen", actor: { type: "user", userId } });
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "engine seen fallback");
    await db()
      .update(schema.deliverables)
      .set({ status: "seen", seenAt: new Date() })
      .where(and(eq(schema.deliverables.id, deliverableId), eq(schema.deliverables.orgId, orgId), eq(schema.deliverables.status, "new")));
  }
}

export default async function DeliverablePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const p = await getPortal(slug);
  const d = await getDeliverable(p.org.id, id);
  if (!d) notFound();
  if (d.status === "new" && !p.access.inherited) await markSeen(p.org.id, d.id, p.user.id);

  const tz = p.org.timezone;
  const via = d.deliveredVia.length ? d.deliveredVia : ["portal" as const];
  const status =
    d.status === "approved"
      ? { tone: "good" as const, label: "Approved" }
      : d.status === "changes_requested"
        ? { tone: "warn" as const, label: "Changes requested" }
        : d.needsReview
          ? { tone: "accent" as const, label: "Needs your OK" }
          : null;

  const meta = (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 text-[13px] md:grid-cols-1">
      {d.workflowName ? (
        <div>
          <dt className="text-ink-4">Part of</dt>
          <dd className="mt-1 text-ink-2">{d.workflowName}</dd>
        </div>
      ) : null}
      <div>
        <dt className="text-ink-4">Type</dt>
        <dd className="mt-1 inline-flex items-center gap-1.5 text-ink-2">
          <KindIcon kind={d.kind} className="text-ink-3" /> {kindLabel(d.kind)}
        </dd>
      </div>
      <div>
        <dt className="text-ink-4">Delivered via</dt>
        <dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-ink-2">
          {via.map((v) => (
            <span key={v} className="inline-flex items-center gap-1.5">
              <ChannelIcon channel={v} className="text-ink-3" /> {CHANNEL_LABEL[v] ?? v}
            </span>
          ))}
        </dd>
      </div>
      {d.hoursSaved > 0 ? (
        <div>
          <dt className="text-ink-4">Time saved</dt>
          <dd className="mt-1 text-ink-2">{hoursPhrase(d.hoursSaved).replace(/^~/, "About ")}</dd>
        </div>
      ) : null}
      <div>
        <dt className="text-ink-4">Delivered</dt>
        <dd className="mt-1 text-ink-2 tabular">
          {longDate(tz, d.createdAt)}, {clockTime(d.createdAt, tz)}
        </dd>
      </div>
    </dl>
  );

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pt-5 md:px-6 md:pt-8">
      <Link
        href={`/p/${slug}`}
        className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Today
      </Link>

      <div className="mt-4 grid gap-10 md:grid-cols-[minmax(0,1fr)_220px] md:gap-12">
        <article className="min-w-0 animate-rise">
          <header>
            <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
              <AgentOrb seed={d.agent.seed} size={28} />
              <span>
                <Link href={`/p/${slug}/team/${d.agent.id}`} className="font-medium text-ink-2 hover:text-ink">
                  {d.agent.name}
                </Link>
                <span className="text-ink-4"> · {d.agent.role}</span>
              </span>
            </div>
            <h1 className="mt-4 text-[26px] leading-[1.2] font-semibold tracking-[-0.025em] text-ink text-balance md:text-[30px]">{d.title}</h1>
            {status ? (
              <div className="mt-3">
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </div>
            ) : null}
          </header>

          <div className="mt-6 rounded-2xl border border-line bg-surface px-5 py-6 shadow-sm md:px-10 md:py-9">
            <Markdown className="portal-reading">{d.body}</Markdown>
          </div>

          <ReviewPanel
            slug={slug}
            deliverableId={d.id}
            agentName={d.agent.name}
            status={d.status}
            needsReview={d.needsReview}
            sendsOnApprove={d.sendsOnApprove}
            feedback={d.feedback}
            canAct={p.canAct}
          />

          <div className="mt-8 md:hidden">{meta}</div>

          {p.canAct ? (
            <section aria-labelledby="reply" className="mt-10">
              <h2 id="reply" className="mb-3 text-[13px] font-semibold text-ink">
                Reply to {d.agent.name}
              </h2>
              <AskComposer
                slug={slug}
                agents={[d.agent]}
                lockAgent
                prefix={`About “${d.title}”:`}
                placeholder={`Ask a question or add a note for ${d.agent.name}…`}
              />
            </section>
          ) : null}
        </article>

        <aside className="hidden md:block">
          <div className="sticky top-24">{meta}</div>
        </aside>
      </div>
    </div>
  );
}
