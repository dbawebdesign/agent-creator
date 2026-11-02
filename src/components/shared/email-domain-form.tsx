"use client";

/**
 * White-label agent email domain (agency or reselling client settings → Branding).
 *
 *   const s = await getEmailDomainSettings(org.id);   // from "@/server/channels/domains" (server)
 *   <EmailDomainForm orgId={org.id} current={s.current} effectiveDomain={s.effectiveDomain} platformDomain={s.platformDomain} />
 *
 * Requires admin on an agency or client org (enforced by the server actions).
 */
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { checkEmailDomainAction, removeEmailDomainAction, setEmailDomainAction } from "@/server/channels/actions";
import type { EmailDomainView } from "@/server/channels/domains";

/**
 * Whether agent addresses actually work right now, from the channels service (`emailReadinessFrom`):
 * "receiving", "sending_only" or "not_set_up", with one plain line on what's missing.
 */
export type EmailReadinessView = { state: "receiving" | "sending_only" | "not_set_up"; detail: string };

export function ReadinessPill({ r }: { r: EmailReadinessView }) {
  if (r.state === "receiving") return <Badge tone="good" dot>Receiving</Badge>;
  if (r.state === "sending_only") return <Badge tone="warn" dot>Sending only</Badge>;
  return <Badge tone="warn" dot>Not receiving yet</Badge>;
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function StatusBadge({ d, readiness }: { d: EmailDomainView; readiness?: EmailReadinessView }) {
  // Verified DNS isn't the same as working mail: once verified, say whether mail actually flows.
  if (d.status === "verified") return readiness ? <ReadinessPill r={readiness} /> : <Badge tone={d.simulated ? "warn" : "good"} dot>{d.simulated ? "Test mode" : "Verified"}</Badge>;
  if (d.status === "failed") return <Badge tone="bad" dot>Verification failed</Badge>;
  return <Badge tone="warn" dot>Waiting for DNS</Badge>;
}

export function EmailDomainForm({
  orgId,
  current,
  effectiveDomain,
  platformDomain,
  readiness,
  className,
}: {
  orgId: string;
  /** Honest mail status (see EmailReadinessView). Without it the badge only reflects DNS verification. */
  readiness?: EmailReadinessView;
  current: EmailDomainView | null;
  /** The domain agents use right now (this org's, an inherited one, or the platform's). */
  effectiveDomain: string;
  platformDomain: string;
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [domain, setDomain] = useState<EmailDomainView | null>(current);
  const [editing, setEditing] = useState(!current);
  const [value, setValue] = useState(current?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inherited = !domain && effectiveDomain !== platformDomain;

  const save = () => {
    const v = value.trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN_RE.test(v)) {
      setError("Enter a domain like agents.yourcompany.com.");
      return;
    }
    setError(null);
    start(async () => {
      const res = await setEmailDomainAction({ orgId, domain: v });
      if (!res.ok) return setError(res.error);
      setDomain(res.domain);
      setEditing(false);
      toast.success(res.domain.status === "verified" ? `Agents now use @${res.domain.domain}` : "Domain added. Publish the DNS records below.");
      router.refresh();
    });
  };

  const check = () =>
    start(async () => {
      const res = await checkEmailDomainAction({ orgId });
      if (!res.ok) return void toast.error(res.error);
      setDomain(res.domain);
      if (res.domain.status === "verified") toast.success("Domain verified");
      else toast.message("Not verified yet. DNS changes can take a while.");
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      const res = await removeEmailDomainAction({ orgId });
      if (!res.ok) return void toast.error(res.error);
      setDomain(null);
      setValue("");
      setEditing(true);
      toast.success("Custom domain removed");
      router.refresh();
    });

  return (
    <div className={className}>
      {domain && !editing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-xs sm:px-5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[13.5px] text-ink">@{domain.domain}</p>
              <div className="mt-1 sm:hidden">
                <StatusBadge d={domain} readiness={readiness} />
              </div>
              <p className="mt-0.5 text-[12px] text-ink-3">
                {domain.status === "verified" ? (readiness?.detail ?? `Agents send and receive email as name@${domain.domain}.`) : "Agents keep using @" + effectiveDomain + " until this is verified."}
              </p>
            </div>
            <span className="max-sm:hidden">
              <StatusBadge d={domain} readiness={readiness} />
            </span>
            {domain.status !== "verified" ? (
              <Button size="sm" variant="secondary" onClick={check} disabled={pending}>
                {pending ? "Checking…" : "Check now"}
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink data-[state=open]:bg-surface-2" aria-label="Domain actions" disabled={pending}>
                <MoreHorizontal className="size-4" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Change domain
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => setConfirmRemove(true)} className="text-bad">
                  <Trash2 /> Remove…
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
          <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
            <DialogContent title={`Remove @${domain.domain}?`} description={`Agents go back to @${platformDomain}. Anyone emailing the old addresses won't reach them.`}>
              <div className="mt-5 flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="ghost">Cancel</Button>
                </DialogClose>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() => {
                    setConfirmRemove(false);
                    remove();
                  }}
                >
                  Remove domain
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          {domain.status === "verified" ? null : (
            <>
              <p className="text-[12.5px] text-ink-3">
                {domain.note ?? "Add these records at your DNS provider, then check again."}
                {domain.status === "pending" && domain.expiresAt ? ` This claim lapses ${new Date(domain.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} if it isn't verified.` : ""}
              </p>
              {domain.records.length > 0 ? (
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="bg-surface-2 text-ink-3">
                      <tr>
                        <th className="px-2.5 py-1.5 font-medium">Type</th>
                        <th className="px-2.5 py-1.5 font-medium">Name</th>
                        <th className="px-2.5 py-1.5 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domain.records.map((r, i) => (
                        <tr key={`${r.type}-${r.name}-${i}`} className="border-t border-line align-top">
                          <td className="px-2.5 py-1.5 font-mono text-ink-2">{r.type}</td>
                          <td className="px-2.5 py-1.5 font-mono text-ink-2 break-all">{r.name}</td>
                          <td className="px-2.5 py-1.5 font-mono text-ink-2 break-all">
                            {r.priority !== undefined ? `${r.priority} ` : ""}
                            {r.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <>
        {readiness && !domain ? (
          <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
            <span className="font-mono text-[13px] text-ink-2">@{effectiveDomain}</span>
            <ReadinessPill r={readiness} />
            <span className="w-full">{readiness.detail}</span>
          </div>
        ) : null}
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="min-w-56 flex-1">
            <label htmlFor={id} className="sr-only">
              Email domain
            </label>
            <Input
              id={id}
              placeholder="agents.yourcompany.com"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-hint`}
              disabled={pending}
            />
          </div>
          <Button type="submit" variant="primary" disabled={pending || !value.trim()}>
            {pending ? "Saving…" : "Use this domain"}
          </Button>
          {domain ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
          <p id={`${id}-hint`} role={error ? "alert" : undefined} className={error ? "w-full text-[12.5px] text-bad" : "w-full text-[12.5px] text-ink-3"}>
            {error ??
              (inherited
                ? `Agents use @${effectiveDomain} (inherited). Set your own to override it.`
                : `Agents use @${effectiveDomain} until you set a domain you own. A subdomain like agents.yourcompany.com works best.`)}
          </p>
        </form>
        </>
      )}
    </div>
  );
}
