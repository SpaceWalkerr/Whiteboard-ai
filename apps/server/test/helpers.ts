import { pino } from "pino";
import { buildApp, type AppOptions } from "../src/app";
import { createOriginMatcher } from "../src/http/origins";

export const silentLogger = pino({ level: "silent" });

export const isAllowedOrigin = createOriginMatcher({
  allowedOrigins: ["http://localhost:5173"],
  allowedOriginPattern: /^https:\/\/whiteboard-ai-[a-z0-9-]+\.vercel\.app$/,
});

export function testApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    logger: silentLogger,
    isAllowedOrigin,
    readinessChecks: [
      { name: "postgres", check: () => Promise.resolve() },
      { name: "redis", check: () => Promise.resolve() },
    ],
    ...overrides,
  });
}
