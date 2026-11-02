"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/components/shared/relative-time";
import { cn } from "@/lib/utils";
import { createKey, inviteMember, revokeInvite, revokeKey, updateAgency } from "@/app/a/_actions/org";

type Profile = { name: string; website: string; timezone: string; displayName: string; accent: string; logoUrl: string; emailFromName: string; whiteLabel: boolean };

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Berlin", "Europe/Paris", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC"];

export function ProfileForm({ agency, initial, canEdit }: { agency: string; initial: Profile; canEdit: boolean }) {
  const [f, setF] = useState(initial);
  const [pending, start] = useTransition();
  const accent = /^#[0-9a-fA-F]{6}$/.test(f.accent) ? f.accent : "#4f46e5";
  const shown = f.displayName || f.name;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await updateAgency(agency, f);
          if (r.ok) toast.success("Settings saved");
          else toast.error(r.error);
        });
      }}
      className="space-y-12"
    >
      <fieldset disabled={!canEdit} className="space-y-4">
        <legend className="mb-4 text-[14px] font-semibold text-ink">Agency profile</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agency name" htmlFor="s-name">
            <Input id="s-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Website" htmlFor="s-web">
            <Input id="s-web" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="northbeam.ai" />
          </Field>
        </div>
        <Field label="Time zone" htmlFor="s-tz">
          <Select id="s-tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {[...new Set([f.timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>

      <fieldset disabled={!canEdit}>
        <legend className="mb-1 text-[14px] font-semibold text-ink">Client portal branding</legend>
        <p className="mb-5 text-[13px] text-ink-3">Clients see your brand — not ours — in their portal and in email from their AI employees.</p>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name" htmlFor="s-dn">
                <Input id="s-dn" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={f.name} />
              </Field>
              <Field label="Email sender name" htmlFor="s-from">
                <Input id="s-from" value={f.emailFromName} onChange={(e) => setF({ ...f, emailFromName: e.target.value })} placeholder={f.name} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <Field label="Accent color" htmlFor="s-accent">
                <div className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface pr-2 pl-1.5 shadow-xs focus-within:border-accent">
                  <input type="color" value={accent} onChange={(e) => setF({ ...f, accent: e.target.value })} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Pick accent color" />
                  <input id="s-accent" value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value })} placeholder="#4F46E5" className="w-full bg-transparent font-mono text-[12.5px] text-ink focus:outline-none" />
                </div>
              </Field>
              <Field label="Logo URL" htmlFor="s-logo">
                <Input id="s-logo" value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} placeholder="https://…/logo.svg" />
              </Field>
            </div>
            <label htmlFor="s-wl" className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3">
              <span>
                <span className="block text-[13.5px] font-medium text-ink">White-label</span>
                <span className="block text-[12.5px] text-ink-3">Hide every “Powered by Roster” mark from client portals and emails.</span>
              </span>
              <Switch id="s-wl" checked={f.whiteLabel} onCheckedChange={(v) => setF({ ...f, whiteLabel: v })} />
            </label>
          </div>
          <div aria-label="Portal preview" className="overflow-hidden rounded-xl border border-line bg-canvas shadow-xs">
            <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2.5">
              {f.logoUrl && /^https:\/\//.test(f.logoUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.logoUrl} alt="" className="size-5 rounded object-contain" />
              ) : (
                <span className="flex size-5 items-center justify-center rounded text-[10px] font-semibold text-white" style={{ background: accent }}>
                  {shown[0]?.toUpperCase()}
                </span>
              )}
              <span className="truncate text-[12.5px] font-semibold text-ink">{shown}</span>
            </div>
            <div className="space-y-2 p-3">
              <p className="text-[11px] font-medium text-ink-3">Good morning — here’s what your team did</p>
              <div className="rounded-md border border-line bg-surface p-2.5">
                <div className="h-1.5 w-3/4 rounded-full bg-surface-2" />
                <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-surface-2" />
                <span className="mt-2.5 inline-block rounded px-2 py-0.5 text-[10.5px] font-medium text-white" style={{ background: accent }}>
                  Approve
                </span>
              </div>
              <p className={cn("pt-1 text-center text-[10px] text-ink-4", f.whiteLabel && "invisible")}>Powered by Roster</p>
            </div>
          </div>
        </div>
      </fieldset>

      {canEdit ? (
        <div className="flex justify-end border-t border-line pt-5">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function InviteForm({ agency }: { agency: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await inviteMember(agency, { email, role });
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Invited ${email}`);
            setLink(r.link);
            setEmail("");
          });
        }}
      >
        <Input type="email" required placeholder="teammate@agency.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-0 flex-1" aria-label="Email" />
        <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="w-28" aria-label="Role">
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {link ? <CopyBox value={link} className="mt-3" /> : null}
    </div>
  );
}

export function RevokeInviteButton({ agency, id }: { agency: string; id: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => {
        const r = await revokeInvite(agency, id);
        if (r.ok) toast.success("Invitation revoked");
        else toast.error(r.error);
      })}
      className="flex size-7 items-center justify-center rounded-md text-ink-4 hover:bg-surface-2 hover:text-ink"
      aria-label="Revoke invitation"
    >
      <X className="size-3.5" />
    </button>
  );
}

function CopyBox({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-canvas px-3 py-2", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink"
        aria-label="Copy"
      >
        {copied ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function ApiKeyCreate({ agency, scopes }: { agency: string; scopes: { id: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>(scopes.slice(0, 2).map((s) => s.id));
  const [key, setKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setKey(null);
          setName("");
        }
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> New key
      </Button>
      <DialogContent title={key ? "Copy your key" : "New API key"} description={key ? "This is the only time it’s shown. Store it somewhere safe." : "For the REST API and MCP. Scoped to your agency."}>
        {key ? (
          <div className="space-y-4">
            <CopyBox value={key} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await createKey(agency, name, sel);
                if (!r.ok) return void toast.error(r.error);
                setKey(r.key);
              });
            }}
          >
            <Field label="Name" htmlFor="k-name">
              <Input id="k-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier, Claude Desktop…" />
            </Field>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink-2">Scopes</legend>
              <div className="space-y-1.5">
                {scopes.map((s) => (
                  <label key={s.id} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                    <input type="checkbox" checked={sel.includes(s.id)} onChange={(e) => setSel((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} className="size-3.5 accent-[var(--accent)]" />
                    {s.label}
                    <code className="ml-auto font-mono text-[11px] text-ink-4">{s.id}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={pending || !name.trim() || !sel.length}>
                <KeyRound /> {pending ? "Creating…" : "Create key"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RevokeKeyButton({ agency, id, name }: { agency: string; id: string; name: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <DialogContent title={`Revoke “${name}”?`} description="Anything using this key stops working immediately. This can’t be undone.">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await revokeKey(agency, id);
                if (r.ok) {
                  toast.success("Key revoked");
                  setOpen(false);
                } else toast.error(r.error);
              })
            }
          >
            Revoke key
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function KeyAge({ date }: { date: Date | null }) {
  return date ? <RelativeTime date={date} /> : <span>never</span>;
}
