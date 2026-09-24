// Browser-safe: only public VITE_* values belong here. Never add secrets.
import { z } from "zod";

export const webEnvSchema = z.object({
  VITE_API_URL: z
    .url()
    .refine((value) => /^https?:\/\//.test(value), { message: "must be an http(s) URL" })
    .transform((value) => value.replace(/\/$/, "")),
});

export type WebEnv = z.output<typeof webEnvSchema>;
