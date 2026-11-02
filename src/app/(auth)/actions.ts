"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { homePathFor } from "@/server/auth/access";
import {
  authenticate,
  clientIp,
  consumeMagicLink,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  getCurrentUser,
  issueMagicLink,
} from "@/server/auth/session";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { audit } from "@/server/security/audit";
import { rateLimit } from "@/server/security/rate-limit";
import { eq, sql } from "drizzle-orm";

export type AuthState = { error?: string; fieldErrors?: Record<string, string>; email?: string; link?: string; sent?: boolean } | undefined;

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

/**
 * Same-origin path only. Rejects backslashes and control characters outright (browsers strip tabs/newlines, so
 * "/\t/evil.example" would become "//evil.example"), then parses against APP_URL and returns pathname + search.
 */
async function safeNext(next: unknown): Promise<string | null> {
  if (typeof next !== "string" || next.length === 0 || next.length > 500) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  try {
    const base = new URL(env().APP_URL);
    const u = new URL(next, base);
    if (u.origin !== base.origin) return null;
    const out = u.pathname + u.search;
    return out.startsWith("/") && !out.startsWith("//") ? out : null;
  } catch {
    return null;
  }
}

/** Per-IP limiter, skipped when the IP is unknown (a shared "unknown" bucket would let one client lock out everyone). */
async function ipLimit(prefix: string, ip: string | null, limit: number, windowSec: number) {
  if (!ip) return { ok: true as const, resetAt: new Date() };
  return rateLimit(`${prefix}:${ip}`, limit, windowSec);
}

function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = String(issue.path[0] ?? "form");
    if (!out[k]) out[k] = issue.message;
  }
  return out;
}

/** Returns the reset time when `key` has reached `limit` failures in its window, else null. */
async function failuresLocked(key: string, limit: number): Promise<Date | null> {
  try {
    const res = await db().execute(sql`select count, reset_at from rate_limits where key = ${key} and reset_at > now()`);
    const row = res.rows[0] as { count: number; reset_at: string | Date } | undefined;
    return row && Number(row.count) >= limit ? new Date(row.reset_at) : null;
  } catch {
    return null; // table not created yet → nothing recorded
  }
}

const signInSchema = z.object({ email, password: z.string().min(1, "Enter your password").max(200) });

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signInSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), email: String(formData.get("email") ?? "") };
  const ip = clientIp(await headers());
  const failKey = `login:fail:${parsed.data.email}`;
  // Every attempt counts against the network; only failures count against the account.
  const byIp = await ipLimit("login:ip", ip, 100, 15 * 60);
  const locked = await failuresLocked(failKey, 8);
  if (!byIp.ok || locked) {
    const resetAt = locked ?? byIp.resetAt;
    const mins = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 60000));
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, email: parsed.data.email };
  }
  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) {
    await rateLimit(failKey, 8, 15 * 60);
    await audit({ actorType: "system", action: "auth.login_failed", metadata: { email: parsed.data.email }, ip });
    return { error: "That email and password don’t match.", email: parsed.data.email };
  }
  await createSession(user.id);
  await audit({ actorType: "user", actorId: user.id, action: "auth.login", ip });
  redirect((await safeNext(formData.get("next"))) ?? (await homePathFor(user.id)));
}

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email,
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signUpSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), email: String(formData.get("email") ?? "") };
  const ip = clientIp(await headers());
  const rl = await ipLimit("signup:ip", ip, 10, 60 * 60);
  if (!rl.ok) return { error: "Too many sign-ups from this network. Try again later." };
  if (await findUserByEmail(parsed.data.email)) {
    return { fieldErrors: { email: "An account with this email already exists. Sign in instead." }, email: parsed.data.email };
  }
  const user = await createUser(parsed.data);
  await createSession(user.id);
  await audit({ actorType: "user", actorId: user.id, action: "auth.signup", ip });
  redirect("/onboarding");
}

export async function requestMagicLink(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = email.safeParse(formData.get("email"));
  if (!parsed.success) return { fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email" } };
  const ip = clientIp(await headers());
  const [a, b] = await Promise.all([rateLimit(`magic:email:${parsed.data}`, 5, 15 * 60), ipLimit("magic:ip", ip, 20, 15 * 60)]);
  if (!a.ok || !b.ok) return { error: "Too many links requested. Try again in a few minutes.", email: parsed.data };
  const token = await issueMagicLink(parsed.data);
  const next = await safeNext(formData.get("next"));
  const link = `${env().APP_URL}/magic-link/verify?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  const e = env();
  if (e.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `Roster <login@${e.EMAIL_DOMAIN}>`,
          to: [parsed.data],
          subject: "Your Roster sign-in link",
          text: `Sign in to Roster:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. If you didn't ask for it, ignore this email.`,
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}`);
    } catch (err) {
      logger.error({ err }, "magic link email failed");
      return { error: "We couldn’t send the email. Try again in a moment.", email: parsed.data };
    }
    return { sent: true, email: parsed.data };
  }
  // No email provider configured: show the link on screen (development only).
  if (e.NODE_ENV === "production") return { sent: true, email: parsed.data };
  return { sent: true, email: parsed.data, link };
}

export async function verifyMagicLink(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const token = z.string().min(10).max(200).safeParse(formData.get("token"));
  if (!token.success) return { error: "This link is invalid." };
  const addr = await consumeMagicLink(token.data);
  if (!addr) return { error: "This link has expired or was already used." };
  let user = await findUserByEmail(addr);
  let isNew = false;
  if (!user) {
    user = await createUser({ email: addr });
    isNew = true;
  }
  const ip = clientIp(await headers());
  if (!user.emailVerifiedAt) {
    // First proof that this person owns the address. Anyone who pre-registered it with a password must not keep
    // access: drop the unverified password and every existing session before signing the real owner in.
    await db().update(schema.users).set({ emailVerifiedAt: new Date(), ...(isNew ? {} : { passwordHash: null }) }).where(eq(schema.users.id, user.id));
    if (!isNew) {
      const killed = await db().delete(schema.sessions).where(eq(schema.sessions.userId, user.id)).returning({ id: schema.sessions.id });
      await audit({ actorType: "user", actorId: user.id, action: "auth.email_verified", metadata: { clearedPassword: !!user.passwordHash, sessionsRevoked: killed.length }, ip });
    }
  }
  await createSession(user.id);
  await audit({ actorType: "user", actorId: user.id, action: "auth.magic_link", ip });
  redirect((await safeNext(formData.get("next"))) ?? (isNew ? "/onboarding" : await homePathFor(user.id)));
}

export async function signOut(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await audit({ actorType: "user", actorId: user.id, action: "auth.logout" });
  redirect("/login");
}
