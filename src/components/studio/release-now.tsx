"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { releaseNow } from "@/app/a/_actions/agents";

/** Hand a held deliverable to the client now. */
export function ReleaseNowButton({ agency, agentId, runId, clientName }: { agency: string; agentId: string; runId: string; clientName: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await releaseNow(agency, agentId, runId);
          if (!r.ok) return void toast.error(r.error);
          toast.success(`Released to ${clientName}`, { description: "It’s in their portal now." });
          router.refresh();
        })
      }
    >
      <Send className="!size-3.5" /> {pending ? "Releasing…" : "Release now"}
    </Button>
  );
}
