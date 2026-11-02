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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { checkEmailDomainAction, removeEmailDomainAction, setEmailDomainAction } from "@/server/channels/actions";
import type { EmailDomainView } from "@/server/channels/domains";

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function StatusBadge({ d }: { d: EmailDomainView }) {
  if (d.status === "verified") return <Badge tone="good" dot>{d.simulated ? "Verified (test mode)" : "Verified"}</Badge>;
  if (d.status === "failed") return <Badge tone="bad" dot>Verification failed</Badge>;
  return <Badge tone="warn" dot>Waiting for DNS</Badge>;
}

export function EmailDomainForm({
  orgId,
  current,
  effectiveDomain,
  platformDomain,
  className,
}: {
  orgId: string;
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13.5px] text-ink">@{domain.domain}</span>
            <StatusBadge d={domain} />
            <div className="ml-auto flex gap-1.5">
              {domain.status !== "verified" ? (
                <Button size="sm" variant="secondary" onClick={check} disabled={pending}>
                  {pending ? "Checking…" : "Check now"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
                Change
              </Button>
              <Button size="sm" variant="ghost" onClick={remove} disabled={pending}>
                Remove
              </Button>
            </div>
          </div>
          {domain.status === "verified" ? (
            <p className="text-[12.5px] text-ink-3">Agents send and receive email as name@{domain.domain}.</p>
          ) : (
            <>
              <p className="text-[12.5px] text-ink-3">
                Add these records at your DNS provider, then check again. Until then agents keep using @{effectiveDomain}.
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
      )}
    </div>
  );
}
