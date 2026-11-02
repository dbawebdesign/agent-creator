"use client";

/**
 * Give an agent a text-message number, or change/remove it.
 *
 *   const ov = await getChannelOverview(org.id);           // server
 *   const a = ov.agents.find((x) => x.agentId === agent.id)!;
 *   <SmsConnect orgId={org.id} agentId={a.agentId} phone={a.sms.phone} connectionId={a.sms.connectionId} live={ov.providers.sms} />
 *
 * Requires admin on the org (enforced by the server action).
 */
import { Copy, MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import {
  connectSmsAction,
  disconnectChannelAction,
} from "@/server/channels/actions";

const E164 = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(raw: string): string | null {
  let s = raw.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return E164.test(s) ? s : null;
}

export function SmsConnect({
  orgId,
  agentId,
  phone,
  connectionId,
  live = true,
  className,
  audience = "agency",
  agentName,
  providerName,
}: {
  orgId: string;
  agentId: string;
  phone?: string | null;
  connectionId?: string | null;
  /** false when Twilio isn't configured: the number is saved but texts won't send yet. */
  live?: boolean;
  className?: string;
  /**
   * "agency" (default, Studio): the Twilio number form. "client" (portal): read-only. The business owner sees
   * the number to text, or who to ask for one; Twilio setup never reaches them.
   */
  audience?: "agency" | "client";
  /** Client audience copy: the teammate's name and who provides numbers (the agency, or the reseller). */
  agentName?: string;
  providerName?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(!phone);
  const [value, setValue] = useState(phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      setError(
        "Use international format with the country code, like +14155550123.",
      );
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await connectSmsAction({ orgId, agentId, phone: normalized });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setValue(res.phone);
      setEditing(false);
      toast.success(`Texts to ${res.phone} now go to this agent`);
      router.refresh();
    });
  };

  const remove = () => {
    if (!connectionId) return;
    startTransition(async () => {
      const res = await disconnectChannelAction({ orgId, connectionId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setValue("");
      setEditing(true);
      toast.success("Number removed");
      router.refresh();
    });
  };

  if (audience === "client") {
    const who = agentName ?? "this teammate";
    if (!phone) {
      return (
        <p
          className={cn(
            "rounded-lg bg-surface-2/70 px-3.5 py-3 text-[13px] text-ink-3",
            className,
          )}
        >
          Ask {providerName ?? "your agency"} to give {who} a texting number.
        </p>
      );
    }
    return (
      <div className={className}>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
          <MessageSquare className="size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] tabular-nums text-ink">
            {phone}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Copy ${who}'s number`}
            onClick={() =>
              navigator.clipboard
                .writeText(phone)
                .then(() => toast.success("Number copied"))
                .catch(() => toast(phone))
            }
          >
            <Copy aria-hidden /> Copy
          </Button>
        </div>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          {live
            ? `Text this number to reach ${who}.`
            : `Texts won’t go through yet (test mode).`}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      {!editing && phone ? (
        <div className="flex flex-wrap items-center gap-2">
          <MessageSquare className="size-4 text-ink-3" aria-hidden />
          <span className="font-mono text-[13.5px] tabular-nums text-ink">
            {phone}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              disabled={pending}
            >
              Change
            </Button>
            {connectionId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={remove}
                disabled={pending}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="min-w-48 flex-1">
            <label htmlFor={id} className="sr-only">
              Phone number
            </label>
            <Input
              id={id}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+14155550123"
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
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !value.trim()}
          >
            {pending ? "Saving…" : phone ? "Save number" : "Connect number"}
          </Button>
          {phone ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setValue(phone);
                setError(null);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </form>
      )}
      <p
        id={`${id}-hint`}
        className={
          error
            ? "mt-1.5 text-[12.5px] text-bad"
            : "mt-1.5 text-[12.5px] text-ink-3"
        }
        role={error ? "alert" : undefined}
      >
        {error ??
          (editing
            ? "A number from your Twilio account. Point its incoming-message webhook at /api/webhooks/twilio."
            : live
              ? "People can text this number to reach the agent."
              : "Saved. Texts won't send until Twilio is set up (test mode).")}
      </p>
    </div>
  );
}
