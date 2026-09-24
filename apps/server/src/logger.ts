import { pino, type Logger, type LoggerOptions } from "pino";
import type { ServerEnv } from "@whiteboard/shared/env/server";

/** Paths that may carry credentials. Redacted defensively even though we don't log headers today. */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
];

export function createLogger(env: Pick<ServerEnv, "LOG_LEVEL" | "NODE_ENV">): Logger {
  const options: LoggerOptions = {
    level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "whiteboard-server" },
  };
  if (env.NODE_ENV === "development") {
    options.transport = { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l" } };
  }
  return pino(options);
}
