"use client";

import { useActionState, useState } from "react";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/shared/submit-button";
import { slugify } from "@/lib/utils";
import { createAgency, type OnboardingState } from "./actions";

export function OnboardingForm({ defaultName }: { defaultName: string }) {
  const [state, action] = useActionState<OnboardingState, FormData>(createAgency, undefined);
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState(slugify(defaultName));
  const [touched, setTouched] = useState(false);
  return (
    <form action={action} className="space-y-5" noValidate>
      {state?.error ? (
        <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-bad">{state.error}</div>
      ) : null}
      <Field label="Agency name" htmlFor="name" error={state?.fieldErrors?.name}>
        <Input
          id="name"
          name="name"
          required
          autoFocus
          value={name}
          placeholder="Northbeam"
          onChange={(e) => {
            setName(e.target.value);
            if (!touched) setSlug(slugify(e.target.value));
          }}
        />
      </Field>
      <Field label="Studio address" htmlFor="slug" error={state?.fieldErrors?.slug}>
        <div className="flex h-9 items-center rounded-md border border-line bg-surface shadow-xs focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
          <span className="pl-3 text-[13.5px] text-ink-4 select-none">roster.app/a/</span>
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
            }}
            className="h-full flex-1 bg-transparent pr-3 text-[13.5px] text-ink focus:outline-none"
            aria-describedby="slug-hint"
          />
        </div>
      </Field>
      <Field label="Default monthly price per AI employee" htmlFor="price" hint="Flat rate. No setup fee, no token billing. You can add more plans later.">
        <div className="flex h-9 items-center rounded-md border border-line bg-surface shadow-xs focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
          <span className="pl-3 text-[13.5px] text-ink-4 select-none">$</span>
          <input id="price" name="price" type="number" min={0} step={100} defaultValue={5000} className="tabular h-full flex-1 bg-transparent px-1.5 text-[13.5px] text-ink focus:outline-none" />
          <span className="pr-3 text-[13.5px] text-ink-4 select-none">/ month</span>
        </div>
      </Field>
      <SubmitButton variant="primary" size="lg" className="w-full" pendingLabel="Setting up your studio…">
        Create agency
      </SubmitButton>
    </form>
  );
}
