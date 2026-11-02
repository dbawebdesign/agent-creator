"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Building2, Check, ChevronsUpDown, FileText, Plus, Upload } from "lucide-react";
import type { AgentSpec } from "@/server/agents/spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Kbd } from "@/components/ui/page";
import { cn } from "@/lib/utils";
import { hire, pollDiscovery, startDiscovery } from "@/app/a/_actions/agents";
import { CHANNEL_LABEL, OrgMark } from "../bits";
import { ArchitectReading, transcriptStats } from "./reading";
import { fromDraft, ProposalReview, toDraft, type Draft } from "./proposal";
import { Provisioning } from "./provisioning";
import { SAMPLE_TRANSCRIPT } from "./sample";

type Client = { id: string; name: string; slug: string };
type Phase = "compose" | "reading" | "review" | "hiring";

export function NewAgentFlow({
  agency,
  clients,
  initialClientId,
  resume,
  blueprint,
  priceLabel,
}: {
  agency: string;
  clients: Client[];
  initialClientId?: string;
  resume?: { discoveryId: string; clientId: string; clientName: string; transcript: string } | null;
  blueprint?: { id: string; name: string; spec: AgentSpec } | null;
  priceLabel: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(resume ? "reading" : blueprint ? "review" : "compose");
  const [clientId, setClientId] = useState<string | "new" | "">(resume?.clientId ?? initialClientId ?? (clients.length === 1 ? clients[0]!.id : ""));
  const [newClient, setNewClient] = useState({ name: "", industry: "" });
  const [transcript, setTranscript] = useState(resume?.transcript ?? "");
  const [discoveryId, setDiscoveryId] = useState<string | null>(resume?.discoveryId ?? null);
  const [resolvedClient, setResolvedClient] = useState<{ id: string; name: string } | null>(
    resume ? { id: resume.clientId, name: resume.clientName } : null,
  );
  const [draft, setDraftState] = useState<Draft | null>(blueprint ? toDraft(blueprint.spec) : null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [starting, startTransition] = useTransition();
  const [hiring, setHiring] = useState(false);
  const [hiredId, setHiredId] = useState<string | null>(null);
  const [hireError, setHireError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const setDraft = useCallback((fn: (d: Draft) => Draft) => setDraftState((d) => (d ? fn(d) : d)), []);
  const selected = clients.find((c) => c.id === clientId);
  const clientName = resolvedClient?.name ?? selected?.name ?? newClient.name ?? "the client";
  const stats = transcriptStats(transcript);
  const canStart = (clientId === "new" ? newClient.name.trim().length >= 2 : !!selected) && transcript.trim().length >= 200;

  // Poll the discovery until the Architect's proposal is ready.
  useEffect(() => {
    if (phase !== "reading" || !discoveryId) return;
    let alive = true;
    const started = Date.now();
    const poll = async () => {
      try {
        const r = await pollDiscovery(agency, discoveryId);
        if (!alive) return;
        if (r.status === "ready" && r.proposal) {
          setReady(true);
          setResolvedClient({ id: r.clientId, name: r.clientName });
          setTimeout(() => {
            if (!alive) return;
            setDraftState(toDraft(r.proposal!));
            setPhase("review");
            window.scrollTo({ top: 0 });
          }, 1400);
          return;
        }
        if (r.status === "hired" && r.agentId) {
          router.replace(`/a/${agency}/agents/${r.agentId}`);
          return;
        }
        if (r.status === "failed" || r.status === "missing") {
          setFailed(r.status === "missing" ? "We couldn’t find that discovery." : (r.error ?? "The Architect couldn’t read this call."));
          return;
        }
        if (Date.now() - started > 45_000) setSlow(true);
      } catch {
        /* transient — keep polling */
      }
      if (alive) timer = setTimeout(poll, 1200);
    };
    let timer = setTimeout(poll, 900);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, discoveryId, agency, router]);

  const begin = () => {
    if (!canStart) return;
    startTransition(async () => {
      const res = await startDiscovery({
        agency,
        clientId: clientId !== "new" ? clientId : undefined,
        newClient: clientId === "new" ? { name: newClient.name.trim(), industry: newClient.industry.trim() || undefined } : undefined,
        transcript,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDiscoveryId(res.discoveryId);
      setResolvedClient({ id: res.clientId, name: clientId === "new" ? newClient.name.trim() : (selected?.name ?? "") });
      setFailed(null);
      setReady(false);
      setPhase("reading");
      router.replace(`/a/${agency}/agents/new?d=${res.discoveryId}`, { scroll: false });
    });
  };

  const doHire = async () => {
    if (!draft || !resolvedClient && !selected) return;
    const target = resolvedClient?.id ?? selected?.id;
    if (!target) {
      toast.error("Choose a client first.");
      return;
    }
    setHiring(true);
    setHireError(null);
    setHiredId(null);
    setPhase("hiring");
    window.scrollTo({ top: 0 });
    const res = await hire({ agency, clientId: target, discoveryId: discoveryId ?? undefined, blueprintId: blueprint?.id, spec: fromDraft(draft) });
    setHiring(false);
    if (!res.ok) {
      setHireError(res.error);
      return;
    }
    setHiredId(res.agentId);
  };

  const readFile = async (file: File) => {
    if (!/\.(txt|md|vtt|srt)$/i.test(file.name) && !file.type.startsWith("text/")) {
      toast.error("Drop a .txt, .md or .vtt transcript");
      return;
    }
    if (file.size > 2_000_000) {
      toast.error("That file is too large (2 MB max)");
      return;
    }
    let text = await file.text();
    if (/\.(vtt|srt)$/i.test(file.name)) {
      text = text
        .replace(/^WEBVTT.*$/m, "")
        .split(/\n/)
        .filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE)\b/.test(l))
        .map((l) => l.replace(/<v ([^>]+)>/g, "$1: ").replace(/<[^>]+>/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    setTranscript(text);
    toast.success(`Loaded ${file.name}`);
  };

  if (phase === "reading") {
    return <ArchitectReading transcript={transcript} clientName={clientName} done={ready} failed={failed} slow={slow} />;
  }

  if (phase === "hiring" && draft) {
    const channels = [...new Set(draft.workflows.filter((w) => w._on).flatMap((w) => w.deliverTo))].map((c) => CHANNEL_LABEL[c] ?? c);
    return (
      <Provisioning
        agency={agency}
        agentId={hiredId}
        name={draft.name}
        role={draft.role}
        seed={`${draft.name}-${clientName}`}
        memories={draft.seedMemories.length}
        channels={channels}
        error={hireError}
        onOpen={() => hiredId && router.push(`/a/${agency}/agents/${hiredId}?welcome=1`)}
        onBack={() => setPhase("review")}
      />
    );
  }

  if (phase === "review" && draft) {
    return (
      <>
        {blueprint && !resolvedClient ? (
          <div className="mb-8 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
            <span className="text-[13px] text-ink-3">From blueprint <span className="font-medium text-ink-2">{blueprint.name}</span> for</span>
            <ClientPicker clients={clients} value={clientId} onChange={setClientId} allowNew={false} />
          </div>
        ) : null}
        <ProposalReview
          draft={draft}
          setDraft={setDraft}
          clientName={clientName === "the client" ? "your client" : clientName}
          onHire={() => void doHire()}
          hiring={hiring}
          priceLabel={priceLabel}
          onStartOver={() => {
            setDraftState(null);
            setDiscoveryId(null);
            setReady(false);
            setPhase("compose");
            router.replace(`/a/${agency}/agents/new`, { scroll: false });
          }}
        />
      </>
    );
  }

  // Compose
  return (
    <div className="mx-auto max-w-[720px] animate-rise">
      <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink">Hire a new AI employee</h1>
      <p className="mt-1.5 text-[14.5px] text-ink-3">Paste the discovery call. The Architect turns it into a proposal you can edit, then hire.</p>

      <div className="mt-8 space-y-6">
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-2">Who is it for?</p>
          <ClientPicker clients={clients} value={clientId} onChange={setClientId} allowNew />
          {clientId === "new" ? (
            <div className="mt-3 grid gap-3 animate-fade-in sm:grid-cols-2">
              <Input autoFocus placeholder="Business name" aria-label="New client name" value={newClient.name} onChange={(e) => setNewClient((c) => ({ ...c, name: e.target.value }))} />
              <Input placeholder="Industry (optional)" aria-label="Industry" value={newClient.industry} onChange={(e) => setNewClient((c) => ({ ...c, industry: e.target.value }))} />
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <label htmlFor="transcript" className="text-[13px] font-medium text-ink-2">
              Discovery call transcript
            </label>
            {!transcript ? (
              <button type="button" onClick={() => setTranscript(SAMPLE_TRANSCRIPT)} className="text-[12.5px] font-medium text-accent hover:underline underline-offset-2">
                Try a sample call
              </button>
            ) : (
              <span className="tabular text-[12px] text-ink-4">
                {stats.words.toLocaleString()} words{stats.speakers > 1 ? ` · ${stats.speakers} speakers` : ""}
              </span>
            )}
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void readFile(f);
            }}
            className={cn(
              "relative rounded-xl border bg-surface shadow-xs transition-all duration-150 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15",
              dragging ? "border-accent ring-3 ring-accent/15" : "border-line",
            )}
          >
            <textarea
              id="transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  begin();
                }
              }}
              placeholder={"AJ: Walk me through a normal Monday.\nDana: Honestly, Monday starts Sunday night…"}
              className="block min-h-[300px] w-full resize-y rounded-xl bg-transparent px-4 py-3.5 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-4 focus:outline-none"
            />
            {!transcript ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-3 shadow-xs hover:border-line-strong hover:text-ink-2"
                >
                  <Upload className="size-3.5" aria-hidden />
                  Drop a .txt, .md or .vtt file — or browse
                </button>
              </div>
            ) : null}
            {dragging ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-accent-soft text-[13.5px] font-medium text-accent">
                <FileText className="mr-2 size-4" aria-hidden /> Drop to load the transcript
              </div>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.vtt,.srt,text/plain,text/markdown,text/vtt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </div>
          {transcript && transcript.trim().length < 200 ? <p className="mt-2 text-[12.5px] text-ink-4">Paste the full call — a few paragraphs at least.</p> : null}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
          <span className="hidden text-[12px] text-ink-4 sm:inline-flex sm:items-center sm:gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
          <Button variant="primary" size="lg" onClick={begin} disabled={!canStart || starting}>
            {starting ? <span className="size-3.5 animate-spin rounded-full border-2 border-canvas/30 border-t-canvas" /> : null}
            Read the call
          </Button>
        </div>
      </div>
    </div>
  );
}

function ClientPicker({ clients, value, onChange, allowNew }: { clients: Client[]; value: string; onChange: (v: string) => void; allowNew: boolean }) {
  const selected = clients.find((c) => c.id === value);
  return (
    <Menu>
      <MenuTrigger className="inline-flex h-10 min-w-64 items-center gap-2.5 rounded-lg border border-line bg-surface pr-3 pl-2 text-left text-[13.5px] shadow-xs transition-colors hover:border-line-strong data-[state=open]:border-accent focus:outline-none focus-visible:ring-3 focus-visible:ring-accent/15">
        {selected ? (
          <OrgMark name={selected.name} size={24} />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-4">
            {value === "new" ? <Plus className="size-3.5" /> : <Building2 className="size-3.5" />}
          </span>
        )}
        <span className={cn("flex-1 truncate", selected || value === "new" ? "font-medium text-ink" : "text-ink-4")}>
          {selected?.name ?? (value === "new" ? "New client" : "Choose a client")}
        </span>
        <ChevronsUpDown className="size-3.5 text-ink-4" aria-hidden />
      </MenuTrigger>
      <MenuContent className="w-72">
        {clients.length ? <MenuLabel>Clients</MenuLabel> : null}
        <div className="max-h-64 overflow-y-auto">
          {clients.map((c) => (
            <MenuItem key={c.id} onSelect={() => onChange(c.id)}>
              <OrgMark name={c.name} size={20} />
              <span className="truncate">{c.name}</span>
              {c.id === value ? <Check className="ml-auto" /> : null}
            </MenuItem>
          ))}
        </div>
        {allowNew ? (
          <>
            {clients.length ? <MenuSeparator /> : null}
            <MenuItem onSelect={() => onChange("new")}>
              <Plus /> New client
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
