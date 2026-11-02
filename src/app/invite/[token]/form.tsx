"use client";

import { useActionState } from "react";
import { Mail } from "lucide-react";
import { requestMagicLink, type AuthState } from "@/app/(auth)/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { acceptInvite, type InviteState } from "./actions";

export function InviteForm({
  token,
  mode,
  email,
  orgName,
}: {
  token: string;
  /** join: signed in and verified. verify: signed in, email unconfirmed. signin: has a password. magic: everyone else. */
  mode: "join" | "verify" | "signin" | "magic";
  email: string;
  orgName: string;
}) {
  const [state, action] = useActionState<InviteState, FormData>(
    acceptInvite,
    undefined,
  );
  if (mode !== "join") {
    return (
      <div>
        <EmailLink
          token={token}
          email={email}
          primary
          verify={mode === "verify"}
        />
        {mode === "signin" ? (
          <p className="mt-5 text-center text-[13px] text-ink-3">
            Or{" "}
            <a
              href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="font-medium text-ink-2 underline-offset-2 hover:underline"
            >
              sign in with your password
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
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
  verify,
}: {
  token: string;
  email: string;
  primary?: boolean;
  verify?: boolean;
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
          {verify
            ? "First, confirm it’s really you."
            : "To keep this workspace safe, we confirm it’s you."}{" "}
          We’ll email a sign-in link to{" "}
          <span className="font-medium text-ink-2">{email}</span>. Open it and
          you’ll come straight back here to join.
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
        <Mail aria-hidden /> Email me a sign-in link
      </SubmitButton>
    </form>
  );
}
