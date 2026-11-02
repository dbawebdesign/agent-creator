import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://roster:roster@localhost:5432/roster"),
  APP_URL: z.string().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ROSTER_MODEL_SMART: z.string().default("claude-opus-5-5"),
  ROSTER_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  VOYAGE_API_KEY: z.string().optional(),
  EMAIL_DOMAIN: z.string().default("agents.roster.local"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  /**
   * authserv-id(s) of YOUR receiving MTA's Authentication-Results header (comma-separated, e.g. "mx.resend.com").
   * Inbound mail is only treated as sender-verified (DMARC/SPF/DKIM) by a header with this id; unset = no
   * email is ever verified, so members' mail is handled like a stranger's. Required in production with Resend.
   */
  EMAIL_AUTHSERV_ID: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  ORGO_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Signing secret of the Connect webhook endpoint, when it differs from STRIPE_WEBHOOK_SECRET. */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  /** Platform application fee on subscriptions, basis points (0 = none). */
  PLATFORM_FEE_BPS: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  APPROVAL_TTL_HOURS: z.coerce.number().positive().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validated environment. In production, ENCRYPTION_KEY and AUTH_SECRET are required;
 * in development/test, deterministic fallbacks are used so the app runs out of the box.
 */
export function env(): Env {
  if (cached) return cached;
  const result = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  if (!result.success) {
    // Variable names and the rule they broke only: never echo values (they may be secrets).
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid environment: ${issues.join("; ")}`);
  }
  const parsed = result.data;
  const problems = productionProblems(parsed);
  if (problems.length) throw new Error(`Invalid production configuration: ${problems.join("; ")}`);
  cached = parsed;
  return parsed;
}

/** Production-only rules (skipped with ROSTER_ALLOW_INSECURE_DEFAULTS=1). Messages name variables, never values. */
function productionProblems(parsed: Env): string[] {
  if (parsed.NODE_ENV !== "production" || process.env.ROSTER_ALLOW_INSECURE_DEFAULTS === "1") return [];
  const problems: string[] = [];
  const missing: string[] = (["ENCRYPTION_KEY", "AUTH_SECRET"] as const).filter((k) => !parsed[k]);
  // Without it, inbound sender verification fails closed (no email is trusted) — refuse to boot half-configured.
  if ((parsed.RESEND_API_KEY || parsed.RESEND_WEBHOOK_SECRET) && !parsed.EMAIL_AUTHSERV_ID) missing.push("EMAIL_AUTHSERV_ID");
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);
  if (parsed.ENCRYPTION_KEY && Buffer.from(parsed.ENCRYPTION_KEY, "base64").length !== 32) problems.push("ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  if (parsed.AUTH_SECRET && parsed.AUTH_SECRET.length < 32) problems.push("AUTH_SECRET must be at least 32 characters (openssl rand -base64 48)");
  try {
    const u = new URL(parsed.APP_URL);
    // Secure cookies and OAuth/webhook callbacks need https in production (localhost is allowed for smoke tests).
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) problems.push("APP_URL must be https in production");
  } catch {
    problems.push("APP_URL is not a valid URL");
  }
  return problems;
}

/**
 * Configuration problems for /api/health and the boot check, without throwing and without values.
 * Empty when the config is good.
 */
export function configProblems(): string[] {
  try {
    env();
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

/** True when running without a real model (deterministic offline mode). */
export function isOfflineModel(): boolean {
  return !env().ANTHROPIC_API_KEY;
}
