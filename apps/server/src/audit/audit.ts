import { auditLogs, type Database } from "@whiteboard/shared/db";

export type AuditAction =
  | "board.create"
  | "board.delete"
  | "board.restore"
  | "board.purge"
  | "board.public_on"
  | "board.public_off"
  | "member.add"
  | "member.role_change"
  | "member.remove"
  | "invite.create"
  | "invite.accept"
  | "invite.revoke"
  | "share_link.create"
  | "share_link.revoke"
  | "entitlement.change";

export interface AuditEntry {
  action: AuditAction;
  actorId: string | null;
  orgId?: string | null;
  boardId?: string | null;
  targetType: "board" | "member" | "invite" | "share_link" | "entitlement";
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

type Executor = Pick<Database, "insert">;

/**
 * Records a share, permission or deletion action. Call it with the same transaction as the
 * change itself, so the log can never miss an action (or record one that rolled back).
 */
export async function audit(tx: Executor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    action: entry.action,
    actorId: entry.actorId,
    orgId: entry.orgId ?? null,
    boardId: entry.boardId ?? null,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
  });
}
