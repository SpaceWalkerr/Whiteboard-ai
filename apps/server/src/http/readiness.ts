import type { ReadinessResponse } from "@whiteboard/shared/schemas";

export interface DependencyCheck {
  name: string;
  /** Resolves when the dependency is usable, rejects otherwise. */
  check: () => Promise<unknown>;
}

export interface ReadinessResult {
  body: ReadinessResponse;
  failures: { name: string; error: unknown }[];
}

/** Runs all checks in parallel, each bounded by `timeoutMs` so a hung dependency can't hang /readyz. */
export async function runReadinessChecks(
  checks: readonly DependencyCheck[],
  timeoutMs: number,
): Promise<ReadinessResult> {
  const results = await Promise.allSettled(
    checks.map((c) => withTimeout(c.check(), timeoutMs, c.name)),
  );

  const body: ReadinessResponse = { status: "ready", checks: {} };
  const failures: ReadinessResult["failures"] = [];
  results.forEach((result, index) => {
    const name = checks[index]?.name ?? `check_${index}`;
    if (result.status === "fulfilled") {
      body.checks[name] = "up";
    } else {
      body.checks[name] = "down";
      body.status = "not_ready";
      failures.push({ name, error: result.reason });
    }
  });
  return { body, failures };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${name} check timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
