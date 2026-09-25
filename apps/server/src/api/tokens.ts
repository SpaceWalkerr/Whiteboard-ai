import { randomBytes } from "node:crypto";

/** 256-bit random token for share links and invites (URL-safe). Only its hash is stored. */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}
