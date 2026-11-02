import { Check, Mail, MessageSquare, Sparkles } from "lucide-react";
import { AgentOrb } from "@/components/ui/agent-orb";
import { buttonClass } from "@/components/ui/button";
import { ConnectKeys } from "@/components/portal/connect-keys";
import { CopyField } from "@/components/portal/copy";
import { SlackMark } from "@/components/portal/icons";
import { getConnect, getPortal } from "@/server/queries/portal";
import { timeAgo } from "@/lib/utils";
import { providerStatus } from "@/server/channels/service";
import { SmsConnect } from "@/components/shared/sms-connect";
import { slackConfigured } from "@/server/channels/slack";

export const metadata = { title: "Connect" };

function Section({
  icon,
  title,
  body,
  children,
  id,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-line bg-surface p-5 shadow-sm md:p-6"
    >
      <div className="flex items-start gap-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2 [&_svg]:size-[18px]">
          {icon}
        </span>
        <div className="min-w-0">
          <h2
            id={id}
            className="text-[15px] font-semibold tracking-[-0.01em] text-ink"
          >
            {title}
          </h2>
          <p className="mt-0.5 text-[13.5px] text-ink-3 text-pretty">{body}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const p = await getPortal(slug);
  const c = await getConnect(p.org.id);
  let keys: {
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsed: string | null;
    status: string;
  }[] = [];
  if (p.isAdmin) {
    try {
      const { listApiKeys } = await import("@/server/api/keys");
      keys = (await listApiKeys(p.org.id)).map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt.toISOString(),
        lastUsed: k.lastUsedAt ? timeAgo(k.lastUsedAt) : null,
        status: k.status,
      }));
    } catch {
      keys = [];
    }
  }
  const withPhone = c.agents.filter((a) => a.phone);
  const slackReady = slackConfigured();
  const smsLive = providerStatus().sms;
  const provider = p.org.kind === "customer" ? p.brand.name : "your provider";
  const first = c.agents[0]?.name ?? "your team";

  return (
    <div className="mx-auto w-full max-w-[1040px] *:max-w-[720px] px-4 pt-8 md:px-6 md:pt-14">
      <header className="mb-8 animate-rise">
        <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[28px]">
          Reach your team wherever you work
        </h1>
        <p className="mt-1.5 max-w-[60ch] text-[15px] text-ink-3 text-pretty">
          No new app to learn. Email them, text them, mention them in Slack — or
          let Claude and Codex hand them work.
        </p>
      </header>

      <div className="space-y-4">
        <Section
          id="email"
          icon={<Mail />}
          title="Email"
          body="Every teammate has their own inbox. Forward a request, CC them on a thread, or just write — they reply in the same thread."
        >
          {c.agents.filter((a) => a.email).length ? (
            <ul className="space-y-2.5">
              {c.agents
                .filter((a) => a.email)
                .map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="flex min-w-0 items-center gap-2.5 sm:w-44">
                      <AgentOrb seed={a.seed} name={a.name} size={24} />
                      <span className="truncate text-[13.5px] font-medium text-ink">
                        {a.name}
                      </span>
                    </div>
                    <CopyField
                      value={a.email!}
                      label={`Copy ${a.name}'s email address`}
                      className="flex-1"
                    />
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-3">
              Inboxes appear here as soon as your teammates are set up.
            </p>
          )}
        </Section>

        <Section
          id="sms"
          icon={<MessageSquare />}
          title="Text"
          body="Text a teammate from your phone like you would a colleague — great for quick asks on the go."
        >
          {p.isAdmin && c.agents.length ? (
            // Admins give each teammate a number right here; everyone else sees the numbers to text.
            <ul className="space-y-4">
              {c.agents.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-2.5 sm:w-44 sm:pt-2">
                    <AgentOrb seed={a.seed} name={a.name} size={24} />
                    <span className="truncate text-[13.5px] font-medium text-ink">
                      {a.name}
                    </span>
                  </div>
                  <SmsConnect
                    orgId={p.org.id}
                    agentId={a.id}
                    phone={a.phone}
                    connectionId={a.smsConnectionId}
                    live={smsLive}
                    className="min-w-0 flex-1"
                  />
                </li>
              ))}
            </ul>
          ) : withPhone.length ? (
            <ul className="space-y-2.5">
              {withPhone.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-2.5 sm:w-44">
                    <AgentOrb seed={a.seed} name={a.name} size={24} />
                    <span className="truncate text-[13.5px] font-medium text-ink">
                      {a.name}
                    </span>
                  </div>
                  <CopyField
                    value={a.phone!}
                    label={`Copy ${a.name}'s number`}
                    className="flex-1 tabular"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-surface-2/70 px-3.5 py-3 text-[13px] text-ink-3">
              No numbers yet. A workspace admin can give {first} a number here.
            </p>
          )}
        </Section>

        <Section
          id="slack"
          icon={<SlackMark className="!size-[18px]" />}
          title="Slack"
          body={`Add your team to Slack, then mention @${first} in any channel or send a DM. Deliveries can post there too.`}
        >
          {c.slack?.status === "connected" ? (
            <p className="inline-flex items-center gap-2 rounded-lg bg-good-soft px-3 py-2 text-[13px] font-medium text-good">
              <Check className="size-4" aria-hidden /> Connected
              {c.slack.teamName ? ` to ${c.slack.teamName}` : ""}
            </p>
          ) : p.isAdmin && slackReady ? (
            <a
              href={`/api/slack/install?org=${p.org.id}&returnTo=${encodeURIComponent(`/p/${slug}/connect`)}`}
              className={buttonClass("secondary", "lg", "gap-2.5")}
            >
              <SlackMark /> Add to Slack
            </a>
          ) : (
            // No dead buttons: say who can switch it on.
            <p className="rounded-lg bg-surface-2/70 px-3.5 py-3 text-[13px] text-ink-3">
              {!slackReady
                ? `Slack isn’t switched on yet. Ask ${p.org.kind === "customer" ? provider : "your agency"} to enable Slack.`
                : "A workspace admin can add your team to Slack."}
            </p>
          )}
        </Section>

        <Section
          id="mcp"
          icon={<Sparkles />}
          title="Use from Claude or Codex"
          body="Give your AI assistant a direct line to your team. Ask Claude to check on work, hand off a task, or pull the latest delivery."
        >
          <ConnectKeys
            slug={slug}
            appUrl={c.appUrl}
            keys={keys}
            isAdmin={p.isAdmin}
            providerName={provider}
            agentName={c.agents[0]?.name ?? null}
            userFirstName={p.user.name ? p.user.firstName : null}
          />
        </Section>
      </div>
    </div>
  );
}
