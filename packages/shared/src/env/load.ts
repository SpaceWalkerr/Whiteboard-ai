import type { z } from "zod";

/**
 * Thrown when environment variables fail validation. The message names every bad variable
 * and why, but never includes the values: they may be secrets (database passwords, keys).
 */
export class EnvValidationError extends Error {
  readonly issues: readonly { variable: string; problem: string }[];

  constructor(issues: readonly { variable: string; problem: string }[]) {
    const lines = issues.map(({ variable, problem }) => `  - ${variable}: ${problem}`);
    super(
      `Invalid environment configuration:\n${lines.join("\n")}\n` +
        "Copy the app's .env.example to .env and fill in the missing values.",
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

type EnvSource = Record<string, string | boolean | undefined>;

/**
 * Validates `source` (process.env or import.meta.env) against `schema`.
 * Empty strings count as missing so `FOO=` in a .env file cannot satisfy a required var.
 */
export function loadEnv<S extends z.ZodType>(schema: S, source: EnvSource): z.output<S> {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  throw new EnvValidationError(
    result.error.issues.map((issue) => {
      const variable = issue.path.join(".") || "(root)";
      const topLevelKey = issue.path[0];
      const missing =
        issue.code === "invalid_type" &&
        typeof topLevelKey === "string" &&
        !(topLevelKey in cleaned);
      return { variable, problem: missing ? "is required" : issue.message };
    }),
  );
}
