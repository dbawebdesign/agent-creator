"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { inviteMemberAction, revokeInviteAction, saveBrandingAction, savePrefsAction } from "@/app/p/[org]/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { CopyField } from "./copy";
import { BrandMark } from "./shell";
import { cn } from "@/lib/utils";

export function InviteForm({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const router = useRouter();
  return (
    <div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          const email = String(fd.get("email") ?? "");
          setError(null);
          start(async () => {
            const res = await inviteMemberAction({ slug, email, role: String(fd.get("role") ?? "member") as "member" });
            if (!res.ok) return setError(res.error);
            setLink({ email, url: res.inviteUrl });
            form.reset();
            toast.success("Invite created");
            router.refresh();
          });
        }}
      >
        <label htmlFor="invite-email" className="sr-only">
          Email
        </label>
        <Input id="invite-email" name="email" type="email" required placeholder="teammate@yourbusiness.com" className="flex-1" />
        <div className="flex gap-2">
          <label htmlFor="invite-role" className="sr-only">
            Role
          </label>
          <Select id="invite-role" name="role" defaultValue="member" className="w-32">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </Select>
          <Button type="submit" variant="accent" size="lg" className="h-9" disabled={pending} aria-busy={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Invite
          </Button>
        </div>
      </form>
      {error ? (
        <p className="mt-2 text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
      {link ? (
        <div className="mt-3 rounded-lg bg-surface-2/70 p-3 animate-fade-in">
          <p className="mb-2 text-[12.5px] text-ink-3">Send {link.email} this link. It expires in 14 days.</p>
          <CopyField value={link.url} label="Copy invite link" mono className="bg-surface" />
        </div>
      ) : null}
    </div>
  );
}

export function RevokeInvite({ slug, inviteId, email }: { slug: string; inviteId: string; email: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Cancel invite for ${email}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await revokeInviteAction({ slug, inviteId });
          if (!res.ok) return void toast.error(res.error);
          toast.success("Invite canceled");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      Cancel
    </Button>
  );
}

const CHANNELS = [
  { id: "email", label: "Email", body: "Each delivery lands in your inbox." },
  { id: "sms", label: "Text message", body: "A short text with a link — handy on the go." },
  { id: "slack", label: "Slack", body: "Posted to your connected Slack." },
] as const;
type Ch = "email" | "sms" | "slack" | "portal";

export function PrefsForm({ slug, initial, email }: { slug: string; initial: { channels: Ch[]; cadence: "instant" | "digest" }; email: string }) {
  const [channels, setChannels] = useState<Ch[]>(initial.channels);
  const [cadence, setCadence] = useState(initial.cadence);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const save = (next: { channels: Ch[]; cadence: "instant" | "digest" }) => {
    setSaved(false);
    start(async () => {
      const res = await savePrefsAction({ slug, ...next });
      if (!res.ok) return void toast.error(res.error);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    });
  };
  return (
    <div className="space-y-5">
      <ul className="divide-y divide-line rounded-xl border border-line">
        {CHANNELS.map((c) => {
          const on = channels.includes(c.id);
          return (
            <li key={c.id} className="flex items-center gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <label htmlFor={`ch-${c.id}`} className="block text-[13.5px] font-medium text-ink">
                  {c.label}
                </label>
                <p className="text-[12.5px] text-ink-3">{c.id === "email" ? `Sent to ${email}.` : c.body}</p>
              </div>
              <Switch
                id={`ch-${c.id}`}
                checked={on}
                onCheckedChange={(v) => {
                  const next = v ? [...channels, c.id] : channels.filter((x) => x !== c.id);
                  setChannels(next);
                  save({ channels: next, cadence });
                }}
              />
            </li>
          );
        })}
      </ul>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">When</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { id: "instant", label: "As it’s delivered", body: "Hear about each piece of work right away." },
              { id: "digest", label: "Morning digest", body: "One calm summary at 7 AM." },
            ] as const
          ).map((o) => (
            <label
              key={o.id}
              className={cn(
                "flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors",
                cadence === o.id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
              )}
            >
              <input
                type="radio"
                name="cadence"
                value={o.id}
                checked={cadence === o.id}
                onChange={() => {
                  setCadence(o.id);
                  save({ channels, cadence: o.id });
                }}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span>
                <span className="block text-[13.5px] font-medium text-ink">{o.label}</span>
                <span className="block text-[12.5px] text-ink-3">{o.body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="h-4 text-[12.5px] text-ink-3" role="status" aria-live="polite">
        {pending ? "Saving…" : saved ? (
          <span className="inline-flex items-center gap-1 text-good">
            <Check className="size-3.5" aria-hidden /> Saved
          </span>
        ) : channels.length === 0 ? "You’ll only see deliveries here in the portal." : ""}
      </p>
    </div>
  );
}

const SWATCHES = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#0284c7", "#4f46e5", "#7c3aed", "#18181b"];

export function BrandingForm({ slug, initial, fallbackName }: { slug: string; initial: { displayName: string; accent: string; logoUrl: string }; fallbackName: string }) {
  const [name, setName] = useState(initial.displayName);
  const [accent, setAccent] = useState(initial.accent || "#4f46e5");
  const [logo, setLogo] = useState(initial.logoUrl);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const shownName = name.trim() || fallbackName;
  const validLogo = /^https:\/\/\S+$/.test(logo) ? logo : null;
  return (
    <form
      className="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await saveBrandingAction({ slug, displayName: name, accent, logoUrl: logo });
          if (!res.ok) return setError(res.error);
          toast.success("Branding saved", { description: "Your portal and your customers’ portals now use it." });
          router.refresh();
        });
      }}
    >
      <div className="space-y-4">
        <Field label="Display name" htmlFor="b-name" hint="Shown at the top of your portal and your customers’ portals.">
          <Input id="b-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={fallbackName} maxLength={60} />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink-2" id="accent-label">
            Accent color
          </span>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-labelledby="accent-label">
            {SWATCHES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={accent.toLowerCase() === s}
                aria-label={s}
                onClick={() => setAccent(s)}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-surface transition-shadow",
                  accent.toLowerCase() === s ? "ring-2 ring-ink" : "ring-1 ring-black/10 hover:ring-2 hover:ring-line-strong",
                )}
                style={{ background: s }}
              />
            ))}
            <label className="relative ml-1 inline-flex h-8 items-center gap-2 rounded-md border border-line bg-surface pr-2 pl-1 text-[12.5px] text-ink-3">
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Custom color" />
              <span className="font-mono uppercase">{accent}</span>
            </label>
          </div>
        </div>
        <Field label="Logo" htmlFor="b-logo" hint="Optional. A square image link (https://…).">
          <Input id="b-logo" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://yourbusiness.com/logo.png" inputMode="url" />
        </Field>
        {error ? (
          <p className="text-[13px] text-bad" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="accent" disabled={pending} aria-busy={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          Save branding
        </Button>
      </div>
      <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-canvas" style={{ ["--accent" as string]: accent, ["--color-accent" as string]: accent }}>
        <div className="flex h-11 items-center gap-2 border-b border-line bg-surface px-3">
          <BrandMark name={shownName} logoUrl={validLogo} size={20} />
          <span className="truncate text-[13px] font-semibold text-ink">{shownName}</span>
        </div>
        <div className="space-y-2 p-3">
          <p className="text-[11px] text-ink-3">Preview</p>
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Good morning</p>
          <div className="h-2 w-3/4 rounded-full bg-surface-2" />
          <div className="h-2 w-1/2 rounded-full bg-surface-2" />
          <span className="mt-1 inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-white" style={{ background: accent }}>
            Approve
          </span>
        </div>
      </div>
    </form>
  );
}
