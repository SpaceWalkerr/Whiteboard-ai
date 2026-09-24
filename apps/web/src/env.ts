import { loadEnv } from "@whiteboard/shared/env";
import { webEnvSchema, type WebEnv } from "@whiteboard/shared/env/web";

/** Throws EnvValidationError if the build was made without the required VITE_* values. */
export function readWebEnv(): WebEnv {
  return loadEnv(webEnvSchema, import.meta.env);
}
