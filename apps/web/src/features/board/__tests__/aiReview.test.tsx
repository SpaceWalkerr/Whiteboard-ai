import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGraph,
  type AiReview,
  type HintsResponse,
  type ReviewRecord,
  type ReviewStreamEvent,
  type ReviewSummary,
} from "@whiteboard/graph";
import type { Shape } from "@whiteboard/shared/board";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiRequestError } from "@/lib/apiClient";
import { HintsController } from "../review/HintsController";
import { pinPlacements } from "../review/pins";
import { ReviewStore, type ReviewApi } from "../review/ReviewStore";
import { readReviewEvents } from "../review/sse";
import { matchShortcut, type KeyInput } from "../keyboard/shortcuts";
import { createArrowShape } from "../model/defaults";
import { ReviewPanel } from "../ui/ReviewPanel";
import { ReviewPins } from "../ui/ReviewPins";
import { UpgradeDialog } from "../ui/UpgradeDialog";
import { box, setup } from "./fixtures";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

function arrow(id: string, from: string, to: string): Shape {
  return createArrowShape(
    { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, fromShapeId: from, toShapeId: to },
    { id, zIndex: "a0", userId: "test", now: 0 },
  );
}

function boardShapes(): Shape[] {
  return [
    box("client", { x: 0, y: 0, width: 120, height: 80 }, "app", { label: "Web app" }),
    box("service", { x: 200, y: 0, width: 120, height: 80 }, "api", { label: "API" }),
    box("database", { x: 400, y: 0, width: 120, height: 80 }, "db", { label: "Postgres" }),
    arrow("a1", "app", "api"),
    arrow("a2", "api", "db"),
  ];
}

function aiReview(overrides: Partial<AiReview> = {}): AiReview {
  return {
    summary: "Good start; replicate the database first.",
    scores: { scalability: 6, reliability: 3, data_design: 7, security: 8, cost: 7 },
    findings: [
      {
        id: "f1",
        severity: "critical",
        dimension: "reliability",
        title: "Database is a single point of failure",
        explanation: "Every request depends on one Postgres instance.",
        shapeIds: ["db", "a2"],
        suggestion: "Add a replica with automatic failover.",
        ruleId: "db-spof",
      },
      {
        id: "f2",
        severity: "warning",
        dimension: "scalability",
        title: "One API instance",
        explanation: "No horizontal scaling.",
        shapeIds: ["api"],
        suggestion: "Run several behind a load balancer.",
        ruleId: null,
      },
    ],
    followUpQuestions: ["How would you fail over the database?"],
    ...overrides,
  };
}

function record(id: string, createdAt: string, review: AiReview | null = aiReview()): ReviewRecord {
  return {
    id,
    boardId: "11111111-1111-4111-8111-111111111111",
    status: review ? "completed" : "failed",
    requestedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Asha" },
    problemStatement: "Order service",
    requirements: "",
    model: "claude-sonnet-5",
    createdAt,
    completedAt: createdAt,
    errorCode: review ? null : "error",
    review,
    graph: extractGraph(boardShapes()),
    ruleFindings: [],
  };
}

function summary(r: ReviewRecord): ReviewSummary {
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    requestedByName: "Asha",
    problemStatement: r.problemStatement,
    findingCount: r.review?.findings.length ?? 0,
    overallScore: r.review ? 6.2 : null,
  };
}

const OLD = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-09-20T10:00:00.000Z");
const NEW = record(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "2026-09-25T10:00:00.000Z",
  aiReview({
    scores: { scalability: 6, reliability: 7, data_design: 7, security: 8, cost: 7 },
    findings: [
      {
        id: "f1",
        severity: "warning",
        dimension: "scalability",
        title: "Still one API instance",
        explanation: "No horizontal scaling.",
        shapeIds: ["api"],
        suggestion: "Scale out.",
        ruleId: null,
      },
      {
        id: "f2",
        severity: "info",
        dimension: "security",
        title: "No rate limiting",
        explanation: "Public endpoints.",
        shapeIds: ["app", "a1"],
        suggestion: "Add a gateway.",
        ruleId: null,
      },
    ],
  }),
);

/** A readable stream of server-sent events, optionally split mid-event. */
function sse(events: ReviewStreamEvent[], extra = ""): ReadableStream<Uint8Array> {
  const text = `: ping\n\n${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}${extra}`;
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Uneven chunks: events must be reassembled across reads.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
}

function fakeApi(overrides: Partial<ReviewApi> = {}): ReviewApi & { calls: string[] } {
  const calls: string[] = [];
  const records = new Map([OLD, NEW].map((r) => [r.id, r]));
  return {
    calls,
    stream: () => Promise.resolve(sse([])),
    list: () => {
      calls.push("list");
      return Promise.resolve([summary(NEW), summary(OLD)]);
    },
    get: (id) => {
      calls.push(`get:${id}`);
      const r = records.get(id);
      return r ? Promise.resolve(r) : Promise.reject(new ApiRequestError(404, "NOT_FOUND", "gone"));
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── SSE ────────────────────────────────────────────────────────────────────────────────────

describe("readReviewEvents", () => {
  it("reassembles events across chunks and skips keep-alive comments", async () => {
    const events: ReviewStreamEvent[] = [];
    for await (const event of readReviewEvents(
      sse([
        { type: "stage", stage: "preparing" },
        { type: "progress", outputTokens: 42 },
        { type: "done", review: NEW },
      ]),
    ))
      events.push(event);
    expect(events.map((e) => e.type)).toEqual(["stage", "progress", "done"]);
  });

  it("rejects events that don't match the contract", async () => {
    const read = async () => {
      for await (const _ of readReviewEvents(sse([], 'data: {"type":"done","review":{}}\n\n'))) {
        // consume
      }
    };
    await expect(read()).rejects.toThrow(/Unexpected event/);
  });
});

// ── ReviewStore ───────────────────────────────────────────────────────────────────────────

describe("ReviewStore", () => {
  it("opens on the latest completed review and loads the previous one for comparison", async () => {
    const api = fakeApi();
    const review = new ReviewStore(api);
    await review.open();
    expect(review.get()).toMatchObject({ open: true, current: NEW, previous: OLD });
    expect(api.calls).toEqual(["list", `get:${NEW.id}`, `get:${OLD.id}`]);
  });

  it("streams a review: stages, progress, then the stored result", async () => {
    const stages: (string | null)[] = [];
    const review = new ReviewStore(
      fakeApi({
        stream: () =>
          Promise.resolve(
            sse([
              { type: "stage", stage: "preparing" },
              { type: "stage", stage: "reviewing" },
              { type: "progress", outputTokens: 120 },
              { type: "stage", stage: "validating" },
              { type: "done", review: NEW },
            ]),
          ),
      }),
    );
    review.subscribe(() => stages.push(review.get().stage));
    await review.start({ problemStatement: "x", requirements: "" });
    const state = review.get();
    expect(state).toMatchObject({ running: false, current: NEW, completions: 1, error: null });
    expect(state.previous?.id).toBe(OLD.id);
    expect(stages).toContain("reviewing");
    expect(stages).toContain("validating");
  });

  it("shows the upgrade prompt on 402 instead of an error", async () => {
    const review = new ReviewStore(
      fakeApi({
        stream: () =>
          Promise.reject(new ApiRequestError(402, "QUOTA_EXCEEDED", "You've used all 5 reviews.")),
      }),
    );
    await review.start({ problemStatement: "", requirements: "" });
    expect(review.get()).toMatchObject({
      upgrade: { message: "You've used all 5 reviews." },
      error: null,
      running: false,
    });
  });

  it("reports a failed review and an interrupted stream", async () => {
    const failing = new ReviewStore(
      fakeApi({
        stream: () =>
          Promise.resolve(sse([{ type: "error", code: "AI_ERROR", message: "Didn't count." }])),
      }),
    );
    await failing.start({ problemStatement: "", requirements: "" });
    expect(failing.get().error).toEqual({ code: "AI_ERROR", message: "Didn't count." });

    const cut = new ReviewStore(
      fakeApi({ stream: () => Promise.resolve(sse([{ type: "stage", stage: "reviewing" }])) }),
    );
    await cut.start({ problemStatement: "", requirements: "" });
    expect(cut.get().error?.code).toBe("INTERRUPTED");
  });

  it("cancelling aborts the request quietly", async () => {
    let signal: AbortSignal | undefined;
    const review = new ReviewStore(
      fakeApi({
        stream: (_request, s) => {
          signal = s;
          return new Promise((_, reject) => {
            s.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        },
      }),
    );
    const running = review.start({ problemStatement: "", requirements: "" });
    expect(review.get().running).toBe(true);
    review.cancel();
    await running;
    expect(signal?.aborted).toBe(true);
    expect(review.get()).toMatchObject({ running: false, error: null });
  });
});

// ── Live hints ────────────────────────────────────────────────────────────────────────────

describe("HintsController", () => {
  const hintResponse: HintsResponse = {
    skipped: false,
    hints: [{ id: "h_1", severity: "warning", text: "Add a cache", shapeIds: ["db"] }],
  };

  function hintsSetup(respond: () => Promise<HintsResponse> = () => Promise.resolve(hintResponse)) {
    vi.useFakeTimers();
    const { store, controller } = setup();
    const fetch = vi.fn(respond);
    const hints = new HintsController(store, { fetch }, { delayMs: 8000 });
    hints.setEnabled(true);
    return { store, controller, hints, fetch };
  }

  it("asks 8 s after my last edit, and only once the graph has 3 components", async () => {
    const { store, hints, fetch } = hintsSetup();
    const [a, b, c, ...rest] = boardShapes();
    if (!a || !b || !c) throw new Error("fixture");
    store.createShapes([a, b]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).not.toHaveBeenCalled(); // 2 components: nothing useful to say
    store.createShapes([c, ...rest]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hints.get().hints.map((h) => h.id)).toEqual(["h_1"]);
  });

  it("doesn't ask again after moves or colour changes, nor for other people's edits", async () => {
    const { store, controller, fetch } = hintsSetup();
    store.createShapes(boardShapes());
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.select(["api"]);
    controller.nudgeSelection(10, 0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // A collaborator adds a component: it arrives with a remote origin, not mine. (A nested
    // transaction keeps the outer transaction's origin.)
    store.doc.transact(() => {
      store.createShape(box("cache", { x: 0, y: 300, width: 100, height: 60 }, "cache"));
    }, "remote");
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps dismissed hints dismissed and pauses after the hourly limit", async () => {
    let calls = 0;
    const { store, hints, fetch } = hintsSetup(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(hintResponse)
        : Promise.reject(new ApiRequestError(429, "HINT_LIMIT", "limit"));
    });
    store.createShapes(boardShapes());
    await vi.advanceTimersByTimeAsync(8000);
    hints.dismiss("h_1");
    expect(hints.get().hints).toEqual([]);
    store.createShape(box("cache", { x: 0, y: 200, width: 100, height: 60 }, "cache"));
    await vi.advanceTimersByTimeAsync(8000);
    expect(hints.get().notice).toMatch(/paused/);
    store.createShape(box("queue", { x: 0, y: 400, width: 100, height: 60 }, "queue"));
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledTimes(2); // paused: no third call
  });

  it("stops listening when disabled", async () => {
    const { store, hints, fetch } = hintsSetup();
    hints.setEnabled(false);
    store.createShapes(boardShapes());
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Pins ──────────────────────────────────────────────────────────────────────────────────

describe("pinPlacements", () => {
  it("pins boxes at their top-right corner and arrows at their middle, side by side", () => {
    const { store } = setup();
    store.createShapes(boardShapes());
    const { shapes } = store.getSnapshot();
    const findings = [
      ...aiReview().findings,
      { ...aiReview().findings[1], id: "f3", shapeIds: ["api"] },
      { ...aiReview().findings[1], id: "f4", shapeIds: ["a1"] },
      { ...aiReview().findings[1], id: "f5", shapeIds: ["deleted"] },
    ] as AiReview["findings"];
    const pins = pinPlacements(findings, shapes);
    expect(pins.map((p) => [p.findingId, p.number, p.stackIndex])).toEqual([
      ["f1", 1, 0],
      ["f2", 2, 0],
      ["f3", 3, 1],
      ["f4", 4, 0],
    ]);
    expect(pins[0]?.anchor).toEqual({ x: 520, y: 0 }); // db: x 400 + width 120
    const mid = pins[3]?.anchor;
    expect(mid?.y).toBeCloseTo(40);
    expect(mid?.x).toBeGreaterThan(120);
    expect(mid?.x).toBeLessThan(200);
  });

  it("renders pins as labelled buttons that select their finding", async () => {
    const { store, viewport } = setup();
    store.createShapes(boardShapes());
    const onSelect = vi.fn();
    render(
      <ReviewPins
        findings={aiReview().findings}
        store={store}
        viewport={viewport}
        activeId="f2"
        onSelect={onSelect}
      />,
    );
    const pin = screen.getByRole("button", {
      name: /Finding 1 \(Critical\): Database is a single/,
    });
    expect(pin).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /Finding 2/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(pin);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "f1" }));
  });
});

// ── Panel and dialogs ─────────────────────────────────────────────────────────────────────

function renderPanel(
  review: ReviewStore,
  overrides: Partial<Parameters<typeof ReviewPanel>[0]> = {},
) {
  const { store } = setup();
  store.createShapes(boardShapes());
  const props = {
    review,
    store,
    onNewReview: vi.fn(),
    onClose: vi.fn(),
    onFocusFinding: vi.fn(),
    hints: null,
    ...overrides,
  };
  render(
    <TooltipProvider>
      <ReviewPanel {...props} />
    </TooltipProvider>,
  );
  return props;
}

describe("ReviewPanel", () => {
  it("shows the summary, scores, numbered findings and follow-up questions", async () => {
    const review = new ReviewStore(fakeApi());
    await review.open();
    const props = renderPanel(review);
    expect(screen.getByRole("heading", { name: "AI review" })).toHaveFocus();
    expect(screen.getByText(/Good start/)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Reliability score" })).toHaveAttribute("value", "7");
    const findings = within(screen.getByRole("list", { name: "Findings" })).getAllByRole("button");
    expect(findings).toHaveLength(2);
    const first = findings[0];
    if (!first) throw new Error("no findings");
    expect(first).toHaveTextContent("Finding 1:");
    await userEvent.click(first);
    expect(props.onFocusFinding).toHaveBeenCalledWith(expect.objectContaining({ id: "f1" }));
    expect(screen.getByRole("region", { name: "Follow-up questions" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("compares with the previous review: new, still open, resolved and score changes", async () => {
    const review = new ReviewStore(fakeApi());
    await review.open();
    renderPanel(review);
    await userEvent.click(screen.getByRole("checkbox", { name: /Compare with the previous/ }));
    const list = screen.getByRole("list", { name: "Findings" });
    expect(within(list).getByText("Still open")).toBeInTheDocument();
    expect(within(list).getByText("New")).toBeInTheDocument();
    const resolved = screen.getByRole("region", { name: "Resolved since the previous review" });
    expect(resolved).toHaveTextContent("Database is a single point of failure");
    expect(screen.getByLabelText("up 4 since the previous review")).toHaveTextContent("+4");
  });

  it("shows progress while a review runs", async () => {
    let finish: (stream: ReadableStream<Uint8Array>) => void = () => undefined;
    const review = new ReviewStore(
      fakeApi({
        stream: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    );
    renderPanel(review);
    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = review.start({ problemStatement: "", requirements: "" });
    });
    expect(screen.getByRole("list", { name: "Review progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await act(async () => {
      finish(sse([{ type: "done", review: NEW }]));
      await running;
    });
    expect(screen.queryByRole("list", { name: "Review progress" })).not.toBeInTheDocument();
    expect(screen.getByText("Still one API instance")).toBeInTheDocument();
  });

  it("offers live hints to Pro editors and the plans to others", async () => {
    const review = new ReviewStore(fakeApi());
    const onUpgrade = vi.fn();
    renderPanel(review, {
      hints: { available: false, enabled: false, notice: null, onToggle: vi.fn(), onUpgrade },
    });
    expect(screen.getByRole("checkbox", { name: /Live hints/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "See plans" }));
    expect(onUpgrade).toHaveBeenCalled();
  });
});

describe("UpgradeDialog", () => {
  it("explains the limit and compares plans", () => {
    render(<UpgradeDialog message="You've used all 5 AI reviews." onOpenChange={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("You've used all 5 AI reviews.");
    const table = screen.getByRole("table", { name: "Plan comparison" });
    expect(within(table).getByRole("rowheader", { name: /Pro/ })).toBeInTheDocument();
    expect(within(table).getByText("100")).toBeInTheDocument();
  });
});

describe("shortcut", () => {
  it("Shift+R opens the AI review", () => {
    const input: KeyInput = {
      key: "R",
      code: "KeyR",
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    };
    expect(matchShortcut(input, false)).toBe("aiReview");
  });
});
