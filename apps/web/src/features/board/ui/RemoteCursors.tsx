import { useSyncExternalStore } from "react";
import type { Peer } from "../sync/stores";
import { worldToScreen } from "../viewport/viewport";
import type { ViewportStore } from "../viewport/viewportStore";

/** Other people's pointers, drawn as HTML over the canvas (cheap to move, crisp at any zoom). */
export function RemoteCursors({
  peers,
  viewport,
}: {
  peers: readonly Peer[];
  viewport: ViewportStore;
}) {
  const vp = useSyncExternalStore(viewport.subscribe, viewport.get);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {peers.map(({ clientId, presence }) => {
        if (!presence.cursor) return null;
        const p = worldToScreen(vp, presence.cursor);
        return (
          <div
            key={clientId}
            data-remote-cursor={presence.user.name}
            className="absolute top-0 left-0 transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow-sm">
              <path
                d="M1 1l6.5 15 2.2-6.3L16 7.5z"
                fill={presence.user.color}
                stroke="#ffffff"
                strokeWidth="1.2"
              />
            </svg>
            <span
              className="absolute top-4 left-3 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-white shadow-sm"
              style={{ background: presence.user.color }}
            >
              {presence.user.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
