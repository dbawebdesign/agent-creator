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
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validated environment. In production, ENCRYPTION_KEY and AUTH_SECRET are required;
 * in development/test, deterministic fallbacks are used so the app runs out of the box.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  if (parsed.NODE_ENV === "production" && process.env.ROSTER_ALLOW_INSECURE_DEFAULTS !== "1") {
    const missing = (["ENCRYPTION_KEY", "AUTH_SECRET"] as const).filter((k) => !parsed[k]);
    if (missing.length) throw new Error(`Missing required env in production: ${missing.join(", ")}`);
  }
  cached = parsed;
  return parsed;
}

/** True when running without a real model (deterministic offline mode). */
export function isOfflineModel(): boolean {
  return !env().ANTHROPIC_API_KEY;
}
