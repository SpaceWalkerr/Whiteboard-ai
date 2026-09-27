import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { BoardDetail } from "@whiteboard/shared/api";
import {
  bytesToBase64,
  createKeyCheck,
  encryptText,
  generateRoomKeyString,
  importRoomKey,
} from "@whiteboard/shared/sync";
import { AuthContext, type AuthState } from "@/auth/authContext";
import { clearLocalBoardData } from "@/auth/localData";
import { forgetKey, keyFor, rememberedKeyCount, rememberKey } from "../e2e/keyring";
import { PrivateBoardGate } from "../e2e/PrivateBoardGate";
import { unlockBoard } from "../e2e/privateBoards";
import { boardLinkWithKey, keyFromHash, keyFromPasted, withKey } from "../e2e/roomKey";
import { SaveKeyDialog } from "../e2e/SaveKeyDialog";
import { ReviewDialog } from "../ui/ReviewDialog";

const BOARD = "20f9d63e-ea39-4eb7-8aaa-0f60d657d603";

async function privateDetail(title = "Launch plan") {
  const encoded = generateRoomKeyString();
  const roomKey = await importRoomKey(BOARD, encoded);
  const detail: BoardDetail = {
    id: BOARD,
    title: "Private board",
    role: "owner",
    isPublic: false,
    isPrivate: true,
    keyCheck: bytesToBase64(await createKeyCheck(roomKey)),
    encryptedTitle: bytesToBase64(await encryptText(roomKey, "title", title)),
  };
  return { detail, encoded };
}

describe("room key links", () => {
  it("parse the key from the fragment only when it is a real 32-byte key", () => {
    const key = generateRoomKeyString();
    expect(keyFromHash(`#key=${key}`)).toBe(key);
    expect(keyFromHash(`#share=abc&key=${key}`)).toBe(key);
    expect(keyFromHash("#key=short")).toBeNull();
    expect(keyFromHash("")).toBeNull();
  });

  it("build links with the key in the fragment (never the path or query)", () => {
    const key = generateRoomKeyString();
    const link = boardLinkWithKey("https://app.test", BOARD, key);
    expect(link).toBe(`https://app.test/board/${BOARD}#key=${key}`);
    expect(new URL(link).search).toBe("");
    expect(withKey("https://app.test/s/tok#old", key)).toBe(`https://app.test/s/tok#key=${key}`);
  });

  it("accept a pasted link for this board, a share link, or a bare key", () => {
    const key = generateRoomKeyString();
    expect(keyFromPasted(boardLinkWithKey("https://x.test", BOARD, key), BOARD)).toBe(key);
    expect(keyFromPasted(`https://x.test/s/token#key=${key}`, BOARD)).toBe(key);
    expect(keyFromPasted(`  ${key} `, BOARD)).toBe(key);
    expect(
      keyFromPasted(boardLinkWithKey("https://x.test", crypto.randomUUID(), key), BOARD),
    ).toBeNull();
    expect(keyFromPasted("hello", BOARD)).toBeNull();
  });
});

describe("keyring", () => {
  it("remembers, forgets and counts keys, and sign-out wipes them", async () => {
    const id = crypto.randomUUID();
    await rememberKey(id, "k1");
    expect(await keyFor(id)).toBe("k1");
    expect(await rememberedKeyCount()).toBeGreaterThan(0);
    await forgetKey(id);
    expect(await keyFor(id)).toBeNull();
    await rememberKey(id, "k2");
    await clearLocalBoardData();
    expect(await keyFor(id)).toBeNull();
    expect(await rememberedKeyCount()).toBe(0);
  });
});

describe("unlockBoard", () => {
  it("accepts the right key (decrypting the title) and rejects any other", async () => {
    const { detail, encoded } = await privateDetail();
    expect((await unlockBoard(detail, encoded))?.title).toBe("Launch plan");
    expect(await unlockBoard(detail, generateRoomKeyString())).toBeNull();
    expect(await unlockBoard(detail, "garbage")).toBeNull();
  });
});

function renderGate(detail: BoardDetail, hash = "") {
  return render(
    <MemoryRouter initialEntries={[`/board/${BOARD}${hash}`]}>
      <PrivateBoardGate detail={detail}>
        {(board) => <p>Unlocked: {board.title}</p>}
      </PrivateBoardGate>
    </MemoryRouter>,
  );
}

describe("PrivateBoardGate", () => {
  it("opens with the key in the link and remembers it on this device", async () => {
    await clearLocalBoardData();
    const { detail, encoded } = await privateDetail();
    renderGate(detail, `#key=${encoded}`);
    expect(await screen.findByText("Unlocked: Launch plan")).toBeInTheDocument();
    await waitFor(async () => {
      expect(await keyFor(BOARD)).toBe(encoded);
    });
  });

  it("opens from the remembered key without a link", async () => {
    const { detail, encoded } = await privateDetail("From keyring");
    await rememberKey(BOARD, encoded);
    renderGate(detail);
    expect(await screen.findByText("Unlocked: From keyring")).toBeInTheDocument();
  });

  it("asks for the link when there is no key, and explains a wrong one", async () => {
    await clearLocalBoardData();
    const { detail, encoded } = await privateDetail();
    renderGate(detail, `#key=${generateRoomKeyString()}`);
    expect(
      await screen.findByRole("heading", { name: "This board is end-to-end encrypted" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("doesn't unlock this board");

    const input = screen.getByLabelText("Link with key");
    await userEvent.clear(input);
    await userEvent.type(input, "not a link");
    await userEvent.click(screen.getByRole("button", { name: "Open board" }));
    expect(screen.getByRole("alert")).toHaveTextContent("isn't a link to this board");

    await userEvent.clear(input);
    await userEvent.type(input, boardLinkWithKey("https://app.test", BOARD, encoded));
    await userEvent.click(screen.getByRole("button", { name: "Open board" }));
    expect(await screen.findByText("Unlocked: Launch plan")).toBeInTheDocument();
  });
});

describe("SaveKeyDialog", () => {
  it("shows the link and the warning, and continues only once saved", async () => {
    const onDone = vi.fn();
    render(<SaveKeyDialog open link="https://app.test/board/x#key=abc" onDone={onDone} />);
    expect(screen.getByLabelText("Link with key")).toHaveValue("https://app.test/board/x#key=abc");
    expect(screen.getByRole("note")).toHaveTextContent("We can't recover it");
    const start = screen.getByRole("button", { name: "Start drawing" });
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByLabelText("I've saved the link somewhere safe"));
    await userEvent.click(start);
    expect(onDone).toHaveBeenCalled();
  });
});

function withQuota(children: ReactNode) {
  const api = {
    request: () =>
      Promise.resolve({
        plan: "pro",
        reviewsUsed: 1,
        reviewsLimit: 100,
        resetsAt: new Date().toISOString(),
        liveHints: true,
        available: true,
      }),
  };
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={{ api } as unknown as AuthState}>
        {children}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

describe("ReviewDialog on a private board", () => {
  it("requires consent for this review and keeps nothing unless asked", async () => {
    const onStart = vi.fn();
    render(
      withQuota(
        <ReviewDialog
          open
          onOpenChange={vi.fn()}
          initial={{ problemStatement: "", requirements: "" }}
          saving={false}
          privateBoard
          onStart={onStart}
          onUpgrade={vi.fn()}
        />,
      ),
    );
    const start = await screen.findByRole("button", { name: "Start review" });
    await waitFor(() => {
      expect(screen.getByText(/99 of 100 reviews left/)).toBeInTheDocument();
    });
    expect(start).toBeDisabled();
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
    const store = screen.getByRole("checkbox", { name: /Keep this review on the server/ });
    expect(store).not.toBeChecked();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "I agree to send this board's graph for this review" }),
    );
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(
      { problemStatement: "", requirements: "" },
      { store: false },
    );
  });

  it("normal boards start without the consent step", async () => {
    const onStart = vi.fn();
    render(
      withQuota(
        <ReviewDialog
          open
          onOpenChange={vi.fn()}
          initial={{ problemStatement: "URL shortener", requirements: "" }}
          saving={false}
          privateBoard={false}
          onStart={onStart}
          onUpgrade={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onStart).toHaveBeenCalledWith(
      { problemStatement: "URL shortener", requirements: "" },
      null,
    );
  });
});
