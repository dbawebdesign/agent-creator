"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/shared/submit-button";
import { Field, Input } from "@/components/ui/field";
import { acceptInvite, type InviteState } from "./actions";

export function InviteForm({ token, mode, email, orgName }: { token: string; mode: "join" | "signin" | "signup"; email: string; orgName: string }) {
  const [state, action] = useActionState<InviteState, FormData>(acceptInvite, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {mode !== "join" ? (
        <Field label="Email" htmlFor="inv-email">
          <Input id="inv-email" value={email} readOnly disabled className="bg-surface-2" />
        </Field>
      ) : null}
      {mode === "signup" ? (
        <Field label="Your name" htmlFor="inv-name">
          <Input id="inv-name" name="name" autoComplete="name" placeholder="Jordan Lee" maxLength={80} autoFocus />
        </Field>
      ) : null}
      {mode !== "join" ? (
        <Field label={mode === "signup" ? "Create a password" : "Password"} htmlFor="inv-pw" hint={mode === "signup" ? "At least 8 characters." : undefined}>
          <Input
            id="inv-pw"
            name="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : 1}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            autoFocus={mode === "signin"}
          />
        </Field>
      ) : null}
      {state?.error ? (
        <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad" role="alert">
          {state.error}
        </p>
      ) : null}
      <SubmitButton variant="accent" size="lg" className="w-full" pendingLabel="Joining…">
        Join {orgName}
      </SubmitButton>
    </form>
  );
}
