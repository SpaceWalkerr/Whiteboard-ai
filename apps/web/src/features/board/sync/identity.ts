import type { Profile } from "@whiteboard/shared/api";
import type { PresenceUser } from "@whiteboard/shared/sync";

/** Cursor colours: dark enough that white label text passes WCAG AA. */
export const PRESENCE_COLORS = [
  "#b91c1c",
  "#c2410c",
  "#a16207",
  "#15803d",
  "#0f766e",
  "#1d4ed8",
  "#6d28d9",
  "#be185d",
] as const;

/** Stable colour per user id, so someone looks the same to everyone on every board. */
export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0];
}

/** Presence identity: the signed-in profile, or an anonymous guest on a public board. */
export function presenceUserFor(profile: Profile | null, fallbackId: string): PresenceUser {
  if (profile)
    return {
      id: profile.id,
      name: profile.displayName.slice(0, 40) || "Whiteboard user",
      color: colorFor(profile.id),
    };
  return { id: fallbackId, name: "Guest", color: colorFor(fallbackId) };
}
