import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.ROSTER_PROCESS ?? "roster-web" },
  redact: {
    paths: ["*.password", "*.token", "*.apiKey", "*.authorization", "*.secret", "headers.cookie", "headers.authorization"],
    censor: "[redacted]",
  },
});
