import type { Session } from "@supabase/supabase-js";
import type { Profile } from "@whiteboard/shared/api";

/** A profile built from the session itself, used until (or when offline, instead of) /me/bootstrap. */
export function profileFromSession(session: Session | null): Profile | null {
  const user = session?.user;
  if (!user) return null;
  const meta = user.user_metadata as { full_name?: unknown; name?: unknown; avatar_url?: unknown };
  const name = [meta.full_name, meta.name, user.email?.split("@")[0]].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: name ?? "Whiteboard user",
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
  };
}
