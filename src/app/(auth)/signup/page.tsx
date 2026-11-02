import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { homePathFor } from "@/server/auth/access";
import { getCurrentUser } from "@/server/auth/session";
import { SignUpForm } from "../auth-forms";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user) redirect(await homePathFor(user.id));
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Start your agency on Roster</h1>
      <p className="mt-1.5 mb-7 text-[14px] text-ink-3">Turn your next discovery call into an AI employee by morning.</p>
      <SignUpForm />
      <p className="mt-8 text-center text-[13px] text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-ink underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
