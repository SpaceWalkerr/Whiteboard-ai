// Browser-safe: only public VITE_* values belong here. Never add secrets.
import { z } from "zod";

export const webEnvSchema = z.object({
  VITE_API_URL: z
    .url()
    .refine((value) => /^https?:\/\//.test(value), { message: "must be an http(s) URL" })
    .transform((value) => value.replace(/\/$/, "")),
  /** Base URL of the sync server's WebSocket endpoint (same host as the API). */
  VITE_WS_URL: z
    .url()
    .refine((value) => /^wss?:\/\//.test(value), { message: "must be a ws:// or wss:// URL" })
    .transform((value) => value.replace(/\/$/, "")),
  /**
   * Exposes window.__whiteboard test hooks (E2E and performance runs only). Never set this for
   * a deployed build.
   */
  VITE_DEBUG_TOOLS: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export type WebEnv = z.output<typeof webEnvSchema>;
