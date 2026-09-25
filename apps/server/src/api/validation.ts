import type { z } from "zod";
import { BadRequestError } from "../errors";

/** Validates untrusted input (body, params, query); the first problem becomes a 400 message. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  throw new BadRequestError(
    field ? `${field}: ${issue?.message ?? "invalid"}` : (issue?.message ?? "Invalid request"),
  );
}
