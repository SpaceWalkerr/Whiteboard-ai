import { randomUUID } from "node:crypto";

/**
 * Identifies this process among the sync instances (message tagging, lease ownership, logs).
 * INSTANCE_ID if set, else Render's per-instance id, else random. It must be unique per
 * running process, so the random suffix keeps a restarted instance distinct from its
 * previous life (whose lease may still be live in Redis).
 */
export function resolveInstanceId(configured: string | undefined, render: string | undefined) {
  const base = configured ?? render ?? "instance";
  return `${base}-${randomUUID().slice(0, 8)}`;
}
