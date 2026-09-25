import { z } from "zod";

/**
 * REST API contract between apps/web and apps/server. Request bodies are validated with these
 * schemas on the server; responses are validated on the client.
 */

export const boardRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type BoardRole = z.infer<typeof boardRoleSchema>;
export const shareRoleSchema = z.enum(["editor", "viewer"]);
export type ShareRole = z.infer<typeof shareRoleSchema>;

const titleSchema = z.string().trim().min(1).max(120);

export const profileSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

export const bootstrapResponseSchema = z.object({
  profile: profileSchema,
  personalOrgId: z.uuid(),
  /** Invites for this email accepted during this sign-in. */
  acceptedInvites: z.number().int().nonnegative(),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const boardSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  role: boardRoleSchema,
  folderId: z.uuid().nullable(),
  isPublic: z.boolean(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  lastOpenedAt: z.string().nullable(),
  /** Short-lived signed URL, or null if no thumbnail yet. */
  thumbnailUrl: z.string().nullable(),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const boardListResponseSchema = z.object({ boards: z.array(boardSummarySchema) });

export const boardListQuerySchema = z.object({
  view: z.enum(["mine", "shared", "recent", "trash"]).default("mine"),
  q: z.string().trim().max(120).optional(),
  folderId: z.uuid().optional(),
});

export const createBoardSchema = z.object({
  title: titleSchema.optional(),
  folderId: z.uuid().nullable().optional(),
});
export const updateBoardSchema = z
  .object({ title: titleSchema.optional(), folderId: z.uuid().nullable().optional() })
  .refine((v) => v.title !== undefined || v.folderId !== undefined, {
    message: "nothing to update",
  });

export const sharingSettingsSchema = z.object({ isPublic: z.boolean() });

export const memberSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: boardRoleSchema,
});
export type Member = z.infer<typeof memberSchema>;

export const pendingInviteSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: shareRoleSchema,
  expiresAt: z.string(),
});
export type PendingInvite = z.infer<typeof pendingInviteSchema>;

export const shareLinkSchema = z.object({
  id: z.uuid(),
  role: shareRoleSchema,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

export const sharingStateSchema = z.object({
  isPublic: z.boolean(),
  members: z.array(memberSchema),
  invites: z.array(pendingInviteSchema),
  links: z.array(shareLinkSchema),
});
export type SharingState = z.infer<typeof sharingStateSchema>;

export const inviteRequestSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  role: shareRoleSchema,
});
export const updateMemberSchema = z.object({ role: shareRoleSchema });

export const createShareLinkSchema = z.object({
  role: shareRoleSchema,
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});
export const createdShareLinkSchema = shareLinkSchema.extend({
  /** The only time the raw token is ever returned. */
  token: z.string(),
});
export type CreatedShareLink = z.infer<typeof createdShareLinkSchema>;

export const resolveShareLinkSchema = z.object({ token: z.string().min(16).max(128) });
export const resolvedShareLinkSchema = z.object({ boardId: z.uuid(), role: shareRoleSchema });
export const acceptInviteSchema = z.object({ token: z.string().min(16).max(128) });
export const acceptedInviteSchema = z.object({ boardId: z.uuid(), role: boardRoleSchema });

export const ticketRequestSchema = z.object({ shareToken: z.string().min(16).max(128).optional() });
export const ticketResponseSchema = z.object({
  ticket: z.string(),
  role: boardRoleSchema,
  expiresAt: z.string(),
});
export type TicketResponse = z.infer<typeof ticketResponseSchema>;

export const boardDetailSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  role: boardRoleSchema,
  isPublic: z.boolean(),
});
export type BoardDetail = z.infer<typeof boardDetailSchema>;

export const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
