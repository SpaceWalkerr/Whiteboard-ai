import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { BoardStore } from "@whiteboard/shared/board";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadGuest, PRESENCE_COLORS, randomGuest } from "../sync/guestIdentity";
import { PeersStore, throttle } from "../sync/stores";
import { ConnectionStatus, OfflineBanner } from "../ui/ConnectionStatus";
import { PresenceAvatars } from "../ui/PresenceAvatars";

const me = { id: "guest-me", name: "Quiet Gecko", color: "#1d4ed8" };
const other = { id: "guest-2", name: "Brave Otter", color: "#b91c1c" };
const presence = (user: typeof me) => ({ user, cursor: null, selection: [], viewport: null });

describe("guest identity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates a named, coloured guest once and keeps it for this browser", () => {
    const first = loadGuest();
    expect(first.id).toMatch(/^guest-/);
    expect(PRESENCE_COLORS).toContain(first.color);
    expect(loadGuest()).toEqual(first);
  });

  it("replaces corrupted stored identities", () => {
    localStorage.setItem("whiteboard.guest", JSON.stringify({ id: "x", name: "", color: "red" }));
    expect(loadGuest().name).not.toBe("");
  });

  it("generates readable names", () => {
    expect(randomGuest(() => 0).name).toBe("Brave Otter");
  });
});

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers the first call immediately and the latest value after the interval", () => {
    const calls: number[] = [];
    const throttled = throttle((v: number) => calls.push(v), 50);
    throttled(1);
    throttled(2);
    throttled(3);
    expect(calls).toEqual([1]);
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([1, 3]);
  });
});

describe("PeersStore", () => {
  it("lists other clients with valid presence only", () => {
    const doc = new BoardStore().doc;
    const local = new Awareness(doc);
    const store = new PeersStore(local);
    local.setLocalState(presence(me));

    const remote = new Awareness(new BoardStore().doc);
    remote.setLocalState(presence(other));
    const bad = new Awareness(new BoardStore().doc);
    bad.setLocalState({ user: { name: 42 } });
    // Simulate receiving both over the network.
    for (const source of [remote, bad]) {
      local.states.set(source.clientID, source.getLocalState() ?? {});
      local.meta.set(source.clientID, { clock: 1, lastUpdated: Date.now() });
      local.emit("change", [{ added: [source.clientID], updated: [], removed: [] }, "remote"]);
    }

    expect(store.get().map((p) => p.presence.user.name)).toEqual(["Brave Otter"]);
  });
});

describe("presence UI", () => {
  it("announces the connection status in words", () => {
    const { rerender } = render(
      <ConnectionStatus state={{ connection: "connected", save: "saved" }} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    rerender(<ConnectionStatus state={{ connection: "connected", save: "saving" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    rerender(<ConnectionStatus state={{ connection: "reconnecting", save: "saving" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
  });

  it("shows the offline banner only when edits can't reach the server", () => {
    const { rerender } = render(
      <OfflineBanner state={{ connection: "connected", save: "saving" }} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<OfflineBanner state={{ connection: "offline", save: "saved" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You're offline — changes are saved on this device",
    );
    rerender(<OfflineBanner state={{ connection: "reconnecting", save: "saving" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    rerender(<OfflineBanner state={{ connection: "reconnecting", save: "saved" }} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows someone when their avatar is clicked, and lets me rename myself", async () => {
    const onFollow = vi.fn();
    const onRename = vi.fn();
    render(
      <TooltipProvider>
        <PresenceAvatars
          me={me}
          peers={[
            { clientId: 7, presence: presence(other) },
            // Same person in a second tab: shown once.
            { clientId: 8, presence: presence(other) },
          ]}
          followingClientId={null}
          onFollow={onFollow}
          onRename={onRename}
        />
      </TooltipProvider>,
    );
    expect(screen.getAllByRole("button", { name: /Follow Brave Otter/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Follow Brave Otter" }));
    expect(onFollow).toHaveBeenCalledWith(7);

    await userEvent.click(screen.getByRole("button", { name: /You: Quiet Gecko/ }));
    const input = screen.getByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Ada{Enter}");
    act(() => undefined);
    expect(onRename).toHaveBeenCalledWith("Ada");
  });
});
