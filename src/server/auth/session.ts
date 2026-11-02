import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/server/db/client";
import { env } from "@/server/env";
import { hashPassword, randomToken, sha256, verifyPassword } from "@/server/security/crypto";

export const SESSION_COOKIE = "roster_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, sliding
const MAGIC_LINK_TTL_MS = 1000 * 60 * 15;

export type SessionUser = typeof schema.users.$inferSelect;

function secureCookies() {
  return env().APP_URL.startsWith("https://");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomToken(32);
  const h = await headers();
  await db()
    .insert(schema.sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      ip: clientIp(h),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db().delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  jar.delete(SESSION_COOKIE);
}

/** Current user from the session cookie, memoized per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await db()
    .select({ user: schema.users, sessionId: schema.sessions.id, lastUsedAt: schema.sessions.lastUsedAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Slide the session at most once an hour to keep writes cheap.
  if (Date.now() - row.lastUsedAt.getTime() > 1000 * 60 * 60) {
    await db()
      .update(schema.sessions)
      .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(schema.sessions.id, row.sessionId));
  }
  return row.user;
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export function clientIp(h: Headers): string | null {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

export async function findUserByEmail(email: string) {
  const rows = await db()
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  const user = await findUserByEmail(email);
  // Always run a hash comparison to keep timing uniform for unknown users.
  const ok = await verifyPassword(
    password,
    user?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  );
  return user && ok ? user : null;
}

export async function createUser(input: { email: string; name?: string; password?: string }) {
  const [user] = await db()
    .insert(schema.users)
    .values({
      email: input.email.trim().toLowerCase(),
      name: input.name?.trim() || null,
      passwordHash: input.password ? await hashPassword(input.password) : null,
    })
    .returning();
  return user!;
}

/** Issues a single-use magic-link token; returns the raw token for the email link. */
export async function issueMagicLink(email: string): Promise<string> {
  const token = randomToken(32);
  await db()
    .insert(schema.authTokens)
    .values({
      email: email.trim().toLowerCase(),
      purpose: "magic_link",
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    });
  return token;
}

/** Consumes a magic-link token atomically. Returns the email it was issued for. */
export async function consumeMagicLink(token: string): Promise<string | null> {
  const rows = await db()
    .update(schema.authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.authTokens.tokenHash, sha256(token)),
        eq(schema.authTokens.purpose, "magic_link"),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ email: schema.authTokens.email });
  return rows[0]?.email ?? null;
}
