import type { Logger } from "pino";

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Steps run in order: stop taking traffic first, close data stores last. */
  steps: readonly ShutdownStep[];
  timeoutMs: number;
  exit?: (code: number) => void;
}

/**
 * Returns an idempotent shutdown function. Every step runs even if an earlier one fails, and
 * a hard deadline forces exit so the platform never has to SIGKILL us mid-flush.
 */
export function createShutdown(
  options: ShutdownOptions,
): (reason: string, exitCode?: number) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  return async (reason, exitCode = 0) => {
    if (started) return;
    started = true;
    options.logger.info({ reason }, "shutting down");

    const deadline = setTimeout(() => {
      options.logger.error({ timeoutMs: options.timeoutMs }, "shutdown timed out; forcing exit");
      exit(1);
    }, options.timeoutMs);
    deadline.unref();

    let code = exitCode;
    for (const step of options.steps) {
      try {
        await step.run();
      } catch (error) {
        code = 1;
        options.logger.error({ err: error, step: step.name }, "shutdown step failed");
      }
    }

    clearTimeout(deadline);
    options.logger.info({ exitCode: code }, "shutdown complete");
    exit(code);
  };
}
