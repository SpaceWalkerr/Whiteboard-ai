import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "../src/shutdown";
import { silentLogger } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("runs every step in order and exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger: silentLogger,
      timeoutMs: 1000,
      exit,
      steps: ["websockets", "http", "redis", "postgres"].map((name) => ({
        name,
        run: () => {
          order.push(name);
          return Promise.resolve();
        },
      })),
    });

    await shutdown("SIGTERM");

    expect(order).toEqual(["websockets", "http", "redis", "postgres"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps closing remaining resources when a step fails, then exits 1", async () => {
    const exit = vi.fn();
    const postgres = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      logger: silentLogger,
      timeoutMs: 1000,
      exit,
      steps: [
        { name: "redis", run: () => Promise.reject(new Error("already closed")) },
        { name: "postgres", run: postgres },
      ],
    });

    await shutdown("SIGTERM");

    expect(postgres).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("is idempotent when signalled twice", async () => {
    const exit = vi.fn();
    const run = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      logger: silentLogger,
      timeoutMs: 1000,
      exit,
      steps: [{ name: "http", run }],
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(run).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("forces exit 1 when a step hangs past the deadline", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger: silentLogger,
      timeoutMs: 5000,
      exit,
      steps: [{ name: "http", run: () => new Promise(() => undefined) }],
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
