"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { saveAsBlueprint } from "@/app/a/_actions/agents";

export function SaveBlueprintDialog({ open, onOpenChange, agency, agentId, defaultName }: { open: boolean; onOpenChange: (o: boolean) => void; agency: string; agentId: string; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Save as blueprint" description="Reuse this agent’s job, workflows and voice for another client. Memories and conversations stay private.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await saveAsBlueprint(agency, agentId, name);
              if (!r.ok) return void toast.error(r.error);
              onOpenChange(false);
              toast.success("Blueprint saved", { action: { label: "View", onClick: () => router.push(`/a/${agency}/blueprints`) } });
            });
          }}
          className="space-y-4"
        >
          <Field label="Blueprint name" htmlFor="bp-name">
            <Input id="bp-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || name.trim().length < 2}>
              {pending ? "Saving…" : "Save blueprint"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
