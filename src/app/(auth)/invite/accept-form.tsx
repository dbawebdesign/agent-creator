"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/shared/submit-button";
import { acceptInvite } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvite, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state?.error ? <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-bad">{state.error}</div> : null}
      <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Joining…">
        Accept invitation
      </SubmitButton>
    </form>
  );
}
