import { hasRole, requireOrg } from "@/server/auth/access";
import { getTeam } from "@/server/queries/studio";
import { Avatar } from "@/components/ui/agent-orb";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { SectionHeading } from "@/components/studio/bits";
import { ApiKeyCreate, InviteForm, KeyAge, ProfileForm, RevokeInviteButton, RevokeKeyButton } from "@/components/studio/settings-forms";

export const metadata = { title: "Settings" };

async function loadKeys(orgId: string) {
  try {
    const mod = await import("@/server/api/keys");
    const keys = await mod.listApiKeys(orgId);
    return { keys, scopes: mod.API_SCOPES.map((s) => ({ id: s, label: mod.SCOPE_LABELS[s] })) };
  } catch {
    return null;
  }
}

export default async function SettingsPage({ params }: { params: Promise<{ agency: string }> }) {
  const { agency: slug } = await params;
  const access = await requireOrg(slug, "viewer");
  const org = access.org;
  const admin = hasRole(access, "admin");
  const [{ members, invites }, keys] = await Promise.all([getTeam(org.id), admin ? loadKeys(org.id) : Promise.resolve(null)]);
  const b = org.branding;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12 [&>*]:max-w-[800px]">
      <header className="mb-10">
        <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-ink">Settings</h1>
        <p className="mt-1 text-[14px] text-ink-3">Your agency, your brand, your team and API access.</p>
      </header>

      <ProfileForm
        agency={slug}
        canEdit={admin}
        initial={{
          name: org.name,
          website: org.website ?? "",
          timezone: org.timezone,
          displayName: b.displayName ?? "",
          accent: b.accent ?? "",
          logoUrl: b.logoUrl ?? "",
          emailFromName: b.emailFromName ?? "",
          showPoweredBy: (b as { showPoweredBy?: unknown }).showPoweredBy === true,
        }}
      />

      <section id="team" className="mt-16 scroll-mt-8">
        <SectionHeading title="Team" count={members.length} className="[&_h2]:text-[14px]" />
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <Avatar name={m.name ?? m.email} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-ink">
                  {m.name ?? m.email}
                  {m.userId === access.user.id ? <span className="ml-1.5 font-normal text-ink-4">(you)</span> : null}
                </p>
                <p className="truncate text-[12px] text-ink-3">{m.email}</p>
              </div>
              <span className="text-[12.5px] text-ink-3 capitalize">{m.role}</span>
            </li>
          ))}
          {invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className="flex size-7 items-center justify-center rounded-full border border-dashed border-line-strong text-[11px] text-ink-3">@</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] text-ink-2">{i.email}</p>
                <p className="text-[12px] text-ink-3">
                  Invited <RelativeTime date={i.createdAt} /> · {i.expiresAt < new Date() ? "expired" : "pending"}
                </p>
              </div>
              <span className="text-[12.5px] text-ink-3 capitalize">{i.role}</span>
              {admin ? <RevokeInviteButton agency={slug} id={i.id} /> : null}
            </li>
          ))}
        </ul>
        {admin ? (
          <div className="mt-4">
            <InviteForm agency={slug} />
          </div>
        ) : null}
      </section>

      {admin ? (
        <section id="api" className="mt-16 scroll-mt-8">
          <SectionHeading title="API keys" count={keys?.keys.length} className="[&_h2]:text-[14px]" action={keys ? <ApiKeyCreate agency={slug} scopes={keys.scopes} /> : null} />
          <p className="-mt-1 mb-4 text-[13px] text-ink-3">For the REST API at /api/v1 and the MCP server at /api/mcp.</p>
          {!keys ? (
            <p className="rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3">API keys aren’t available yet.</p>
          ) : keys.keys.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
              {keys.keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink">
                      {k.name}
                      <code className="ml-2 font-mono text-[12px] font-normal text-ink-3">{k.prefix}…</code>
                    </p>
                    <p className="truncate text-[12px] text-ink-3">
                      {k.scopes.join(", ")} · last used <KeyAge date={k.lastUsedAt} />
                    </p>
                  </div>
                  {k.status === "active" ? <RevokeKeyButton agency={slug} id={k.id} name={k.name} /> : <Badge>{k.status === "revoked" ? "Revoked" : "Expired"}</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-line px-5 py-6 text-[13.5px] text-ink-3">No keys yet. Create one to connect Claude, Zapier or your own code.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
