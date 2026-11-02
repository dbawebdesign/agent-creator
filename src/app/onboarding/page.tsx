import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/shared/logo";
import { Toaster } from "@/components/shared/toaster";
import { userOrgs } from "@/server/auth/access";
import { requireUser } from "@/server/auth/session";
import { OnboardingForm } from "./form";

export const metadata: Metadata = { title: "Create your agency" };

export default async function OnboardingPage() {
  const user = await requireUser();
  const orgs = await userOrgs(user.id);
  const agency = orgs.find((o) => o.org.kind === "agency");
  if (agency) redirect(`/a/${agency.org.slug}`);
  const first = (user.name ?? user.email.split("@")[0] ?? "").split(/\s+/)[0] ?? "";
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-16 items-center px-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16">
        <div className="w-full max-w-[400px] animate-rise">
          <p className="text-[13px] font-medium text-ink-3">Step 1 of 1</p>
          <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-ink">
            {first ? `Welcome, ${first}. ` : ""}Name your agency
          </h1>
          <p className="mt-1.5 mb-8 text-[14px] text-ink-3">
            This is your studio — where discovery calls become AI employees. Clients see your name, never ours.
          </p>
          <OnboardingForm defaultName="" />
        </div>
      </main>
      <Toaster />
    </div>
  );
}
