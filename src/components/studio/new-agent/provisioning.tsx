"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Brain, Check, Library, Mail, Monitor, Radio } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pollProvisioning } from "@/app/a/_actions/agents";

type Status = Awaited<ReturnType<typeof pollProvisioning>>;

export function Provisioning({
  agency,
  agentId,
  name,
  role,
  seed,
  memories,
  channels,
  error,
  onOpen,
  onBack,
}: {
  agency: string;
  agentId: string | null;
  name: string;
  role: string;
  seed: string;
  memories: number;
  channels: string[];
  error: string | null;
  onOpen: () => void;
  onBack: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<Status>(null);
  const opened = useRef(false);

  // Each layer lands on a steady beat; layers after the first wait for the hire to return.
  useEffect(() => {
    if (error) return;
    const t = setInterval(() => setTick((n) => (agentId || n < 1 ? Math.min(6, n + 1) : n)), 650);
    return () => clearInterval(t);
  }, [agentId, error]);

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    const load = () => pollProvisioning(agency, agentId).then((s) => alive && setStatus(s)).catch(() => {});
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agency, agentId]);

  const done = tick >= 6 && !!agentId;
  useEffect(() => {
    if (!done || opened.current) return;
    const t = setTimeout(() => {
      opened.current = true;
      onOpen();
    }, 1800);
    return () => clearTimeout(t);
  }, [done, onOpen]);

  const layers = [
    { icon: Brain, label: "Memory", detail: `${status?.memories || memories} facts from the call` },
    { icon: Library, label: "Knowledge base", detail: "Discovery transcript indexed" },
    { icon: Mail, label: "Its own inbox", detail: status?.inbox ?? "Reserving an address…" },
    {
      icon: Monitor,
      label: "A computer",
      detail: status?.computer === "ready" ? "Cloud computer ready" : status?.computer === "starting" ? "Booting a cloud computer…" : "Runtime ready",
    },
    { icon: Radio, label: "Channels", detail: channels.join(", ") || "Portal" },
  ];

  return (
    <div className="mx-auto max-w-[520px] pt-6 animate-fade-in" aria-live="polite">
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <span className={cn("absolute -inset-3 rounded-full bg-accent/10 blur-md transition-opacity duration-700", done ? "opacity-100" : "opacity-0")} aria-hidden />
          <AgentOrb seed={seed} size={64} live={done} className={cn("transition-transform duration-700", done ? "scale-100" : "scale-95")} />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">
          {error ? `${name} couldn’t be hired` : done ? `${name} is on the roster` : `Setting up ${name}`}
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">{error ?? role}</p>
      </div>

      <ul className="mt-9 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {layers.map((l, i) => {
          const state = tick > i ? "done" : tick === i && !error ? "active" : "todo";
          return (
            <li key={l.label} className={cn("flex items-center gap-3.5 px-4 py-3.5 transition-colors duration-300", i > 0 && "border-t border-line", state === "active" && "bg-surface-2/50")}>
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-300",
                  state === "done" ? "border-transparent bg-accent-soft text-accent" : "border-line text-ink-4",
                )}
              >
                <l.icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13.5px] font-medium transition-colors", state === "todo" ? "text-ink-4" : "text-ink")}>{l.label}</p>
                <p className={cn("truncate text-[12.5px] transition-opacity duration-300", state === "done" ? "text-ink-3 opacity-100" : "opacity-0")}>{l.detail}</p>
              </div>
              <span className="flex size-5 items-center justify-center" aria-label={state === "done" ? "Done" : state === "active" ? "In progress" : "Waiting"}>
                {state === "done" ? (
                  <Check className="size-4 text-good animate-fade-in" strokeWidth={2.5} />
                ) : state === "active" ? (
                  <span className="size-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
                ) : (
                  <span className="size-1.5 rounded-full bg-line-strong" />
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className={cn("mt-6 flex flex-col items-center gap-3 transition-opacity duration-500", done || error ? "opacity-100" : "opacity-0")}>
        {error ? (
          <Button variant="secondary" onClick={onBack}>
            Back to the proposal
          </Button>
        ) : (
          <>
            <p className="text-[13px] text-ink-3">The first overnight deliverable is queued for tonight.</p>
            <Button variant="primary" onClick={onOpen} disabled={!done}>
              Meet {name} <ArrowRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
