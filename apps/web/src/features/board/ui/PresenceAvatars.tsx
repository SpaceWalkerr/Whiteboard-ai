import type { PresenceUser } from "@whiteboard/shared/sync";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Peer } from "../sync/stores";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({ user, className }: { user: PresenceUser; className?: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-background",
        className,
      )}
      style={{ background: user.color }}
    >
      {initials(user.name)}
    </span>
  );
}

interface Props {
  me: PresenceUser;
  peers: readonly Peer[];
  followingClientId: number | null;
  onFollow: (clientId: number | null) => void;
}

/** Who is here. Click someone to follow their view. */
export function PresenceAvatars({ me, peers, followingClientId, onFollow }: Props) {
  // One avatar per person even if they have the board open in several tabs (first tab wins,
  // so "follow" consistently tracks the same one).
  const people: Peer[] = [];
  const seen = new Set<string>([me.id]);
  for (const peer of peers) {
    if (seen.has(peer.presence.user.id)) continue;
    seen.add(peer.presence.user.id);
    people.push(peer);
  }

  return (
    <div role="group" aria-label="People on this board" className="flex items-center -space-x-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={`You: ${me.name}`} className="rounded-full">
            <Avatar user={me} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{me.name} (you)</TooltipContent>
      </Tooltip>
      {people.map((peer) => {
        const following = peer.clientId === followingClientId;
        return (
          <Tooltip key={peer.presence.user.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={
                  following
                    ? `Stop following ${peer.presence.user.name}`
                    : `Follow ${peer.presence.user.name}`
                }
                aria-pressed={following}
                className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => {
                  onFollow(following ? null : peer.clientId);
                }}
              >
                <Avatar
                  user={peer.presence.user}
                  className={following ? "ring-foreground" : undefined}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {following
                ? `Following ${peer.presence.user.name}`
                : `${peer.presence.user.name} — click to follow`}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
