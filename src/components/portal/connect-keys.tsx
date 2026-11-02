"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { KeyRound, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/p/[org]/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { mcpConfigSnippet } from "@/server/api/mcp-config";
import { CopyButton, CopyField } from "./copy";
import { cn } from "@/lib/utils";

type Key = { id: string; name: string; prefix: string; createdAt: string; lastUsed: string | null; status: string };

const TABS = [
  { id: "claudeCode", label: "Claude Code" },
  { id: "claudeDesktop", label: "Claude Desktop" },
  { id: "codex", label: "Codex" },
] as const;

export function ConnectKeys({
  slug,
  appUrl,
  keys,
  isAdmin,
  providerName,
  agentName,
  userFirstName,
}: {
  slug: string;
  appUrl: string;
  keys: Key[];
  isAdmin: boolean;
  providerName: string;
  /** A real teammate's name for the example prompt; null when the team is empty. */
  agentName: string | null;
  userFirstName: string | null;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("claudeCode");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const active = keys.filter((k) => k.status === "active");
  const snippets = mcpConfigSnippet(appUrl, fresh?.key ?? "rk_live_YOUR_KEY");
  const snippet = snippets[tab];

  const create = () => {
    start(async () => {
      const res = await createApiKeyAction({ slug, name: name.trim() || "Claude" });
      if (!res.ok) return void toast.error(res.error);
      setFresh({ key: res.key, name: name.trim() || "Claude" });
      setCreating(false);
      setName("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      {fresh ? (
        <div className="rounded-xl border border-good/25 bg-good-soft p-4 animate-rise" role="status">
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-good">
            <ShieldCheck className="size-4" aria-hidden /> Your key for “{fresh.name}” is ready
          </p>
          <p className="mt-1 text-[13px] text-ink-3">Copy it now — for your security we’ll never show it again. It’s already filled in below.</p>
          <CopyField value={fresh.key} label="Copy API key" mono className="mt-3 bg-surface" />
        </div>
      ) : null}

      <div>
        <div role="tablist" aria-label="Assistant" className="no-scrollbar flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "h-8 shrink-0 rounded-md px-3 text-[13px] transition-colors",
                tab === t.id ? "bg-surface-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative mt-2 rounded-lg border border-line bg-surface-2/60">
          <pre className="overflow-x-auto px-4 py-3.5 pr-12 font-mono text-[12px] leading-relaxed whitespace-pre text-ink-2">
            <code>{snippet}</code>
          </pre>
          <CopyButton value={snippet} label="Copy setup snippet" toastLabel="Copied" className="absolute top-2 right-2" />
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">
          {tab === "claudeCode"
            ? `Paste into your terminal. Then just ask Claude: “${agentName ? `Have ${agentName} draft` : "Have my team draft"} this week’s status update.”`
            : tab === "claudeDesktop"
              ? "Add to Claude Desktop → Settings → Developer → Edit config, then restart Claude."
              : "Add to your Codex config and set the key in your shell."}
        </p>
      </div>

      {isAdmin ? (
        <div className="border-t border-line pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-ink">Access keys</p>
            {!creating ? (
              <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> New key
              </Button>
            ) : null}
          </div>
          {creating ? (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row animate-fade-in"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <label htmlFor="key-name" className="sr-only">
                Key name
              </label>
              <Input id="key-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={userFirstName ? `Name it, e.g. ${userFirstName}’s Claude` : "Name it, e.g. My laptop"} maxLength={80} />
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="accent" disabled={pending} aria-busy={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : null}
                  Create key
                </Button>
              </div>
            </form>
          ) : null}
          {active.length ? (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
              {active.map((k) => (
                <KeyRow key={k.id} k={k} slug={slug} />
              ))}
            </ul>
          ) : !creating ? (
            <p className="mt-2 text-[13px] text-ink-3">No keys yet. Create one to connect Claude or Codex.</p>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-line pt-4 text-[13px] text-ink-3">Ask a workspace admin for an access key — or {providerName} can set it up for you.</p>
      )}
    </div>
  );
}

function KeyRow({ k, slug }: { k: Key; slug: string }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const router = useRouter();
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      <KeyRound className="size-4 shrink-0 text-ink-3" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{k.name}</p>
        <p className="truncate text-[12px] text-ink-3">
          <span className="font-mono">{k.prefix}…</span> · {k.lastUsed ? `Last used ${k.lastUsed}` : "Never used"}
        </p>
      </div>
      {confirm ? (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={pending}>
            Keep
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await revokeApiKeyAction({ slug, keyId: k.id });
                if (!res.ok) return void toast.error(res.error);
                toast.success("Key revoked");
                router.refresh();
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Revoke
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Revoke ${k.name}`}>
          Revoke
        </Button>
      )}
    </li>
  );
}
