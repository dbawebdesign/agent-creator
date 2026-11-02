"use client";

import { useActionState } from "react";
import { Mail } from "lucide-react";
import { requestMagicLink, type AuthState } from "@/app/(auth)/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Field, Input } from "@/components/ui/field";
import { acceptInvite, type InviteState } from "./actions";

export function InviteForm({
  token,
  mode,
  email,
  orgName,
}: {
  token: string;
  mode: "join" | "signin" | "signup" | "magic";
  email: string;
  orgName: string;
}) {
  const [state, action] = useActionState<InviteState, FormData>(
    acceptInvite,
    undefined,
  );
  if (mode === "magic")
    return <EmailLink token={token} email={email} primary />;
  return (
    <>
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        {mode !== "join" ? (
          <Field label="Email" htmlFor="inv-email">
            <Input
              id="inv-email"
              value={email}
              readOnly
              disabled
              className="bg-surface-2"
            />
          </Field>
        ) : null}
        {mode === "signup" ? (
          <Field label="Your name" htmlFor="inv-name">
            <Input
              id="inv-name"
              name="name"
              autoComplete="name"
              placeholder="Jordan Lee"
              maxLength={80}
              autoFocus
            />
          </Field>
        ) : null}
        {mode !== "join" ? (
          <Field
            label={mode === "signup" ? "Create a password" : "Password"}
            htmlFor="inv-pw"
            hint={mode === "signup" ? "At least 8 characters." : undefined}
          >
            <Input
              id="inv-pw"
              name="password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : 1}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              autoFocus={mode === "signin"}
            />
          </Field>
        ) : null}
        {state?.error ? (
          <p
            className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad"
            role="alert"
          >
            {state.error}
          </p>
        ) : null}
        <SubmitButton
          variant="accent"
          size="lg"
          className="w-full"
          pendingLabel="Joining…"
        >
          Join {orgName}
        </SubmitButton>
      </form>
      {mode !== "join" ? <EmailLink token={token} email={email} /> : null}
    </>
  );
}

/**
 * Sign in by email link, then land back on this invite already signed in (where joining is one click).
 * Reuses the app's magic-link action, so its rate limits and delivery apply. The link goes to the invited
 * address only; the invite token alone never signs anyone into an existing account.
 */
function EmailLink({
  token,
  email,
  primary,
}: {
  token: string;
  email: string;
  primary?: boolean;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    requestMagicLink,
    undefined,
  );
  if (state?.sent) {
    return (
      <div
        role="status"
        className={primary ? "" : "mt-6 border-t border-line pt-5"}
      >
        <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <Mail className="size-4 text-ink-3" aria-hidden /> Check {email}
        </p>
        <p className="mt-1 text-[13px] text-ink-3">
          We sent a sign-in link. Open it and you’ll come straight back here to
          join.
        </p>
        {state.link ? (
          <a
            href={state.link}
            className="mt-3 block break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink-2 hover:text-ink"
          >
            {state.link}
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <form
      action={action}
      className={primary ? "space-y-4" : "mt-6 border-t border-line pt-5"}
    >
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="next" value={`/invite/${token}`} />
      {primary ? (
        <p className="text-[13.5px] text-ink-3">
          You already have an account as{" "}
          <span className="font-medium text-ink-2">{email}</span>. We’ll email
          you a sign-in link, then you can join.
        </p>
      ) : null}
      {state?.error || state?.fieldErrors?.email ? (
        <p
          className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad"
          role="alert"
        >
          {state.error ?? state.fieldErrors?.email}
        </p>
      ) : null}
      <SubmitButton
        variant={primary ? "accent" : "secondary"}
        size="lg"
        className="w-full"
        pendingLabel="Sending…"
      >
        <Mail aria-hidden />{" "}
        {primary ? "Email me a sign-in link" : "Use an email link instead"}
      </SubmitButton>
    </form>
  );
}
