import type { z } from "zod";

/** A write to the board would produce a shape that fails schema validation. */
export class BoardValidationError extends Error {
  readonly shapeId: string;
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(shapeId: string, issues: readonly z.core.$ZodIssue[]) {
    super(
      `Invalid shape ${shapeId}: ${issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
    );
    this.name = "BoardValidationError";
    this.shapeId = shapeId;
    this.issues = issues;
  }
}

/** A write was attempted on a board opened in view-only mode. */
export class BoardReadOnlyError extends Error {
  constructor() {
    super("This board is view-only");
    this.name = "BoardReadOnlyError";
  }
}
