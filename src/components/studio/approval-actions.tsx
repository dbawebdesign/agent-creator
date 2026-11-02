"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { decide } from "@/app/a/_actions/agents";

export function ApprovalActions({ agency, approvalId }: { agency: string; approvalId: string }) {
  const [pending, start] = useTransition();
  const go = (d: "approved" | "rejected") =>
    start(async () => {
      const r = await decide(agency, approvalId, d);
      if (r.ok) toast.success(d === "approved" ? "Approved — it’s on its way" : "Declined");
      else toast.error(r.error);
    });
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => go("rejected")}>
        Decline
      </Button>
      <Button size="sm" variant="primary" disabled={pending} onClick={() => go("approved")}>
        Approve
      </Button>
    </div>
  );
}
