import { Avatar } from "@/components/ui/agent-orb";
import { Badge } from "@/components/ui/badge";
import { BrandingForm, InviteForm, PrefsForm, RevokeInvite } from "@/components/portal/settings-forms";
import { getPortal, getSettings, readPrefs } from "@/server/queries/portal";

export const metadata = { title: "Settings" };

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

function Section({ id, title, body, children }: { id: string; title: string; body?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t border-line py-8 first:border-t-0 first:pt-0 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 id={id} className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {body ? <p className="mt-1 text-[13px] text-ink-3 text-pretty">{body}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default async function SettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const s = await getSettings(p.org.id);
  const prefs = readPrefs(p.org, p.user.id);
  const branding = p.org.branding ?? {};

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 pt-8 md:px-6 md:pt-14">
      <header className="mb-10 animate-rise">
        <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[28px]">Settings</h1>
        <p className="mt-1.5 text-[15px] text-ink-3">{p.org.name}</p>
      </header>

      <Section id="notify" title="Where you get your work" body="Your team always delivers here. Choose where else you’d like to hear about it.">
        <PrefsForm slug={slug} initial={{ channels: prefs.channels.filter((c) => c !== "portal") as ("email" | "sms" | "slack")[], cadence: prefs.cadence }} email={p.user.email} />
      </Section>

      <Section id="people" title="People" body={p.isAdmin ? "Invite your staff. Members can review work and ask the team for things; viewers can only look." : "Everyone with access to this portal."}>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {s.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={m.name ?? m.email} size={30} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-ink">
                  {m.name ?? m.email}
                  {m.userId === p.user.id ? <span className="ml-1.5 font-normal text-ink-4">(you)</span> : null}
                </p>
                {m.name ? <p className="truncate text-[12.5px] text-ink-3">{m.email}</p> : null}
              </div>
              <Badge>{ROLE[m.role] ?? m.role}</Badge>
            </li>
          ))}
          {s.invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={i.email} size={30} className="opacity-60" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] text-ink-2">{i.email}</p>
                <p className="text-[12.5px] text-ink-4">Invited · {ROLE[i.role] ?? i.role}</p>
              </div>
              {p.isAdmin ? <RevokeInvite slug={slug} inviteId={i.id} email={i.email} /> : <Badge tone="warn">Pending</Badge>}
            </li>
          ))}
          {!s.members.length && !s.invites.length ? <li className="px-4 py-6 text-center text-[13px] text-ink-3">Just you so far.</li> : null}
        </ul>
        {p.isAdmin ? (
          <div className="mt-4">
            <InviteForm slug={slug} />
          </div>
        ) : null}
      </Section>

      {p.canResell && p.isAdmin ? (
        <Section id="brand" title="Your brand" body="Used across your portal and the portals of customers you resell to.">
          <BrandingForm
            slug={slug}
            fallbackName={p.org.name}
            initial={{ displayName: branding.displayName ?? "", accent: branding.accent ?? p.brand.accent ?? "", logoUrl: branding.logoUrl ?? "" }}
          />
        </Section>
      ) : null}
    </div>
  );
}
