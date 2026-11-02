/** Node-only half of instrumentation.ts (kept separate so the Edge bundle never sees process.exit). */
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";

export function validateConfigOrExit() {
  try {
    env();
    logger.info({ nodeEnv: process.env.NODE_ENV }, "web starting: configuration ok");
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "web refused to start: invalid configuration");
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
}
