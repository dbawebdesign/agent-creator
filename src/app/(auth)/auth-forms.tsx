"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ArrowRight, Check, Copy, Mail } from "lucide-react";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/shared/submit-button";
import { requestMagicLink, signIn, signUp, verifyMagicLink, type AuthState } from "./actions";

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-bad">
      {message}
    </div>
  );
}

export function SignInForm({ next }: { next?: string }) {
  const [state, action] = useActionState<AuthState, FormData>(signIn, undefined);
  return (
    <form action={action} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormError message={state?.error} />
      <Field label="Email" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus defaultValue={state?.email} placeholder="you@agency.com" aria-invalid={!!state?.fieldErrors?.email} />
      </Field>
      <Field label="Password" htmlFor="password" error={state?.fieldErrors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!state?.fieldErrors?.password} />
      </Field>
      <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}

export function SignUpForm() {
  const [state, action] = useActionState<AuthState, FormData>(signUp, undefined);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormError message={state?.error} />
      <Field label="Your name" htmlFor="name" error={state?.fieldErrors?.name}>
        <Input id="name" name="name" autoComplete="name" required autoFocus placeholder="AJ Rivera" />
      </Field>
      <Field label="Work email" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={state?.email} placeholder="you@agency.com" />
      </Field>
      <Field label="Password" htmlFor="password" error={state?.fieldErrors?.password} hint="At least 8 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}

export function MagicLinkForm({ next }: { next?: string }) {
  const [state, action] = useActionState<AuthState, FormData>(requestMagicLink, undefined);
  const [copied, setCopied] = useState(false);
  if (state?.sent) {
    return (
      <div className="space-y-5">
        <div className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Mail className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Check your email</h1>
          <p className="mt-1.5 text-[14px] text-ink-3">
            We sent a sign-in link to <span className="font-medium text-ink-2">{state.email}</span>. It expires in 15 minutes.
          </p>
        </div>
        {state.link ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface p-3.5">
            <p className="text-[12px] font-medium text-ink-3">No email provider is configured, so here’s your link:</p>
            <div className="mt-2.5 flex items-center gap-2">
              <a href={state.link} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-canvas hover:bg-ink-2">
                Open sign-in link <ArrowRight className="size-3.5" aria-hidden />
              </a>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(state.link!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-ink-3 hover:text-ink"
                aria-label="Copy link"
              >
                {copied ? <Check className="size-4 text-good" /> : <Copy className="size-4" />}
              </button>
            </div>
          </div>
        ) : null}
        <p className="text-[13px] text-ink-3">
          Wrong address?{" "}
          <Link href="/magic-link" className="font-medium text-ink-2 underline-offset-2 hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4" noValidate>
      <div className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Sign in with email</h1>
        <p className="mt-1.5 text-[14px] text-ink-3">We’ll email you a link that signs you in. No password needed.</p>
      </div>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormError message={state?.error} />
      <Field label="Email" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus defaultValue={state?.email} placeholder="you@agency.com" />
      </Field>
      <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Sending…">
        Email me a link
      </SubmitButton>
    </form>
  );
}

export function VerifyMagicLinkForm({ token, next }: { token: string; next?: string }) {
  const [state, action] = useActionState<AuthState, FormData>(verifyMagicLink, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormError message={state?.error} />
      {state?.error ? (
        <Link href="/magic-link" className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-line bg-surface text-sm font-medium text-ink hover:bg-surface-2">
          Request a new link
        </Link>
      ) : (
        <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Signing in…" autoFocus>
          Continue to Roster
        </SubmitButton>
      )}
    </form>
  );
}
