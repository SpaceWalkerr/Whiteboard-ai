import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BoardStore } from "@whiteboard/shared/board";
import {
  formatCountdown,
  remainingMs,
  type InterviewQuestion,
  type InterviewView,
  type PublicInterviewState,
  type ReplayMarker,
} from "@whiteboard/shared/interview";
import { ReplayTimeline, type ReplayStep } from "@whiteboard/shared/replay";
import { TooltipProvider } from "@/components/ui/tooltip";
import { box } from "@/features/board/__tests__/fixtures";
import type { InterviewApi } from "../api";
import { InterviewBar } from "../InterviewBar";
import { InterviewerPanel } from "../InterviewerPanel";
import { InterviewStore } from "../InterviewStore";
import { ReplayPlayer } from "../replay/ReplayPlayer";
import { ReplayView } from "../replay/ReplayView";

const ME = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";
const INTERVIEW = "33333333-3333-4333-8333-333333333333";
const BOARD = "44444444-4444-4444-8444-444444444444";

const QUESTION: InterviewQuestion = {
  id: "rate-limiter",
  title: "Distributed rate limiter",
  prompt: "Design a rate limiter.",
  difficulty: "medium",
  tags: ["redis"],
  requirements: { functional: ["Limit per key"], nonFunctional: ["< 5 ms"] },
  hints: ["Compare token bucket and sliding window.", "Where is the counter stored?"],
};

function state(overrides: Partial<PublicInterviewState> = {}): PublicInterviewState {
  return {
    interviewId: INTERVIEW,
    boardId: BOARD,
    version: 1,
    status: "active",
    question: {
      id: QUESTION.id,
      title: QUESTION.title,
      prompt: QUESTION.prompt,
      requirements: QUESTION.requirements,
    },
    revealedHints: [],
    timer: {
      durationMs: 30 * 60_000,
      startedAt: 1_000_000,
      pausedAt: null,
      pausedMs: 0,
      endedAt: null,
    },
    participants: [
      { userId: ME, name: "Ivy", role: "interviewer" },
      { userId: CANDIDATE, name: "Cam", role: "candidate" },
    ],
    serverNow: 1_000_000 + 60_000,
    ...overrides,
  };
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("timer", () => {
  it("counts down, freezes while paused and shows over time", () => {
    const timer = state().timer;
    expect(remainingMs(timer, 1_000_000 + 60_000)).toBe(29 * 60_000);
    const paused = { ...timer, pausedAt: 1_000_000 + 120_000 };
    expect(remainingMs(paused, 1_000_000 + 999_999)).toBe(28 * 60_000);
    const resumed = { ...timer, pausedMs: 30_000 };
    expect(remainingMs(resumed, 1_000_000 + 60_000)).toBe(29 * 60_000 + 30_000);
    expect(formatCountdown(29 * 60_000 + 500)).toBe("29:01");
    expect(formatCountdown(-90_000)).toBe("-1:30");
  });
});

describe("InterviewStore", () => {
  it("keeps the newest state, derives my role and corrects for clock skew", () => {
    let now = 5_000;
    const load = vi.fn(() => Promise.resolve(null));
    const store = new InterviewStore(CANDIDATE, load, () => now);
    store.receive(state({ version: 2, serverNow: 9_000 }));
    expect(store.get().myRole).toBe("candidate");
    expect(store.serverNow()).toBe(9_000);
    now = 6_000;
    expect(store.serverNow()).toBe(10_000);
    // An older version (e.g. a slow join message) never replaces a newer one.
    store.receive(state({ version: 1, status: "ended" }));
    expect(store.get().state?.status).toBe("active");
    // Invalid input is ignored.
    store.receive({ interviewId: "nope" });
    expect(store.get().state?.version).toBe(2);
    // Candidates never ask for the question with hints.
    expect(load).not.toHaveBeenCalled();
    expect(store.get().question).toBeNull();
  });

  it("loads the full question only for interviewers", async () => {
    const view: InterviewView = { state: state(), myRole: "interviewer", question: QUESTION };
    const load = vi.fn(() => Promise.resolve(view));
    const store = new InterviewStore(ME, load);
    store.receive(state());
    await vi.waitFor(() => {
      expect(store.get().question?.hints).toHaveLength(2);
    });
    expect(load).toHaveBeenCalledTimes(1);
    store.receive(state({ version: 2 }));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("InterviewBar", () => {
  it("shows the question, revealed hints and the countdown to a candidate — no interviewer tools", () => {
    const store = new InterviewStore(
      CANDIDATE,
      () => Promise.resolve(null),
      () => 1_060_000,
    );
    store.receive(state({ revealedHints: [{ index: 1, text: "Where is the counter stored?" }] }));
    render(wrap(<InterviewBar interview={store} panelOpen={false} onTogglePanel={vi.fn()} />));
    expect(screen.getByRole("heading", { name: QUESTION.title })).toBeInTheDocument();
    expect(screen.getByText("Where is the counter stored?")).toBeInTheDocument();
    expect(screen.queryByText("Compare token bucket and sliding window.")).toBeNull();
    expect(screen.getByRole("timer")).toHaveAccessibleName("Time left 29:00");
    expect(screen.queryByRole("button", { name: /interviewer/i })).toBeNull();
    expect(screen.getByText(/you are the candidate/)).toBeInTheDocument();
  });

  it("gives interviewers a panel toggle and, once ended, a summary link", async () => {
    const onToggle = vi.fn();
    const store = new InterviewStore(
      ME,
      () => Promise.resolve(null),
      () => 1_060_000,
    );
    store.receive(state());
    const { rerender } = render(
      wrap(<InterviewBar interview={store} panelOpen={false} onTogglePanel={onToggle} />),
    );
    await userEvent.click(screen.getByRole("button", { name: /interviewer/i }));
    expect(onToggle).toHaveBeenCalled();
    act(() => {
      store.receive(
        state({ version: 3, status: "ended", timer: { ...state().timer, endedAt: 1_500_000 } }),
      );
    });
    rerender(wrap(<InterviewBar interview={store} panelOpen={false} onTogglePanel={onToggle} />));
    expect(screen.getByRole("link", { name: "View summary" })).toHaveAttribute(
      "href",
      `/interviews/${INTERVIEW}`,
    );
    expect(screen.queryByRole("timer")).toBeNull();
  });
});

describe("InterviewerPanel", () => {
  function fakeApi(overrides: Partial<InterviewApi> = {}): InterviewApi {
    const view = (s: PublicInterviewState): Promise<InterviewView> =>
      Promise.resolve({ state: s, myRole: "interviewer", question: QUESTION });
    return {
      revealHint: vi.fn((_id: string, index: number) =>
        view(state({ version: 2, revealedHints: [{ index, text: QUESTION.hints[index] ?? "" }] })),
      ),
      timer: vi.fn(() => view(state({ version: 2 }))),
      notes: vi.fn(() => Promise.resolve([])),
      addNote: vi.fn(),
      ...overrides,
    } as unknown as InterviewApi;
  }

  it("reveals a hint to the candidate and pauses the timer", async () => {
    const store = new InterviewStore(ME, () => Promise.resolve(null));
    store.applyView({ state: state(), myRole: "interviewer", question: QUESTION });
    const api = fakeApi();
    render(
      wrap(
        <InterviewerPanel
          interview={store}
          api={api}
          me={{ userId: ME, name: "Ivy" }}
          people={[]}
          onClose={vi.fn()}
          onRunReview={vi.fn()}
          onEnded={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText("Only interviewers can see this panel.")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Show to candidate" });
    expect(buttons).toHaveLength(2);
    const [first] = buttons;
    if (!first) throw new Error("no hint buttons");
    await userEvent.click(first);
    expect(api.revealHint).toHaveBeenCalledWith(INTERVIEW, 0);
    expect(await screen.findByText("Shown to the candidate")).toBeInTheDocument();
    expect(store.get().state?.revealedHints.map((h) => h.index)).toEqual([0]);

    await userEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    expect(api.timer).toHaveBeenCalledWith(INTERVIEW, { action: "pause" });
  });

  it("moves between tabs with the arrow keys", async () => {
    const store = new InterviewStore(ME, () => Promise.resolve(null));
    store.applyView({ state: state(), myRole: "interviewer", question: QUESTION });
    render(
      wrap(
        <InterviewerPanel
          interview={store}
          api={fakeApi()}
          me={{ userId: ME, name: "Ivy" }}
          people={[]}
          onClose={vi.fn()}
          onRunReview={vi.fn()}
          onEnded={vi.fn()}
        />,
      ),
    );
    const question = screen.getByRole("tab", { name: "Question" });
    question.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
  });
});

describe("replay", () => {
  /** A session that adds one box every second for 10 s, with a long idle gap in the middle. */
  function session() {
    const source = new BoardStore();
    const base = new Uint8Array([0, 0]); // empty Yjs update
    const steps: ReplayStep[] = [];
    let t = 10_000;
    source.doc.on("update", (update: Uint8Array) => {
      steps.push({ t, update });
    });
    for (let i = 0; i < 10; i++) {
      t += i === 5 ? 60_000 : 1_000;
      source.createShape(
        box("service", { x: i * 150, y: 0, width: 120, height: 80 }, `s${String(i)}`),
      );
    }
    return new ReplayTimeline(base, steps, { start: 10_000, end: t + 1_000 }, 3);
  }

  it("plays forward, seeks back and skips idle time", () => {
    const player = new ReplayPlayer(session());
    expect(player.get().shapes).toHaveLength(0);
    player.seek(13_000);
    expect(player.get().shapes.map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
    player.seek(11_500);
    expect(player.get().shapes).toHaveLength(1);
    player.setSpeed(1);
    player.play();
    player.advance(4_000);
    expect(player.get().shapes).toHaveLength(5);
    // Next edit is a minute away: skip-idle jumps to just before it.
    player.advance(100);
    expect(player.get().time).toBeGreaterThan(70_000);
    expect(player.get().shapes).toHaveLength(5);
    player.advance(1_000);
    expect(player.get().shapes).toHaveLength(6);
    player.advance(1_000_000);
    expect(player.get().playing).toBe(false);
    expect(player.get().shapes).toHaveLength(10);
  });

  it("has a keyboard-operable scrubber and markers that seek", async () => {
    const player = new ReplayPlayer(session());
    const markers: ReplayMarker[] = [
      { kind: "hint_revealed", at: 14_000, label: "Hint 1 revealed", refId: null },
    ];
    render(wrap(<ReplayView player={player} markers={markers} />));
    const slider = screen.getByRole("slider", { name: "Session time" });
    fireEvent.change(slider, { target: { value: "3000" } });
    expect(player.get().shapes).toHaveLength(3);
    expect(slider).toHaveAttribute("aria-valuetext", expect.stringMatching(/^0:03 of /));

    await userEvent.click(screen.getByRole("button", { name: "Jump to 0:04: Hint 1 revealed" }));
    expect(player.get().time).toBe(14_000);
    expect(
      screen.getByRole("img", { name: /0:04 into the session, 4 shapes/ }),
    ).toBeInTheDocument();

    const region = screen.getByRole("region", { name: "Replay player" });
    fireEvent.keyDown(slider, { key: " " });
    expect(player.get().playing).toBe(true);
    await userEvent.click(within(region).getByRole("button", { name: "Pause replay" }));
    expect(player.get().playing).toBe(false);
  });
});
