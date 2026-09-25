import { z } from "zod";
import { shapeIdSchema } from "../board/shapes";

const finite = z.number();

/**
 * What each client publishes through the awareness protocol. Validated on receipt (server
 * and clients) — awareness is untrusted input like any other network message.
 */
export const presenceSchema = z.object({
  user: z.object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  /** Pointer position in world coordinates; null when the pointer is off the canvas. */
  cursor: z.object({ x: finite, y: finite }).nullable(),
  selection: z.array(shapeIdSchema).max(5000),
  /** The user's visible area, for "follow" mode. */
  viewport: z
    .object({
      x: finite,
      y: finite,
      scale: z.number().positive().max(100),
      width: z.number().min(0).max(100_000),
      height: z.number().min(0).max(100_000),
    })
    .nullable(),
});

export type Presence = z.infer<typeof presenceSchema>;
export type PresenceUser = Presence["user"];
