"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setWorkflowEnabledAction } from "@/app/p/[org]/actions";
import { Switch } from "@/components/ui/switch";

/** Pause or resume a routine in place. Optimistic, with the switch rolled back if the save fails. */
export function WorkflowSwitch({
  slug,
  workflowId,
  name,
  enabled,
}: {
  slug: string;
  workflowId: string;
  name: string;
  enabled: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-ink-3">
      {/* The switch already says "on"; only the exception gets words. */}
      {on ? null : <span aria-hidden>Paused</span>}
      <Switch
        checked={on}
        disabled={pending}
        aria-label={on ? `Pause ${name}` : `Resume ${name}`}
        onCheckedChange={(next) => {
          setOn(next);
          start(async () => {
            const res = await setWorkflowEnabledAction({
              slug,
              workflowId,
              enabled: next,
            });
            if (!res.ok) {
              setOn(!next);
              toast.error(res.error);
              return;
            }
            toast.success(next ? `${name} is back on` : `${name} is paused`, {
              description: next
                ? "It picks up again at its next scheduled time."
                : "Nothing new will run until you turn it back on.",
            });
            router.refresh();
          });
        }}
      />
    </label>
  );
}
