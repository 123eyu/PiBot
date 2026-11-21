import { availableParallelism, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { type AsyncCommandResult, runLoggedAsync } from "./async-command.ts";
import { classifyFailure, exceptionReason } from "./check-failure.ts";
import { ACCEPTANCE, excerptOf, type VerifyResult, type VerifyTarget } from "./checks.ts";
import { pnpmEnv } from "./context.ts";
import { withAsyncVerifyLock } from "./verify-lock.ts";

const HOUR = 60 * 60_000;
const failureOf = (run: AsyncCommandResult, text: string, labels: string[]) =>
  !run.drained
    ? { kind: "harness" as const, reason: "process_cleanup_unconfirmed" }
    : run.cancelled
      ? { kind: "harness" as const, reason: "workflow_cancelled" }
      : run.errorCode &&
          [
            "process_group_leaked",
            "process_kill_failed",
            "output_limit",
            "log_unavailable",
          ].includes(run.errorCode)
        ? { kind: "harness" as const, reason: run.errorCode }
        : classifyFailure(run, text, labels);

/** Legacy verify remains synchronous; only this explicit lane promises cooperative cancellation. */
export async function verifyAsync(
  task: VerifyTarget,
  options: { signal: AbortSignal; prepare?: () => Promise<void> },
): Promise<VerifyResult> {
  const started = Date.now();
  let latest: AsyncCommandResult | undefined;
  let cleanupUnknown = false;
  try {
    return await withAsyncVerifyLock(options.signal, async (unknown) => {
      try {
        await options.prepare?.();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "electron_preflight:local_process_cleanup_unconfirmed"
        ) {
          cleanupUnknown = true;
          unknown(undefined);
        }
        throw error;
      }
      const execute = async (name: string, args: string[], timeoutMs: number) => {
        options.signal.throwIfAborted();
        latest = await runLoggedAsync(task.id, name, "pnpm", args, {
          cwd: task.worktree,
          env: pnpmEnv,
          timeoutMs,
          signal: options.signal,
        });
        if (!latest.drained) {
          cleanupUnknown = true;
          unknown(latest.pid);
        }
        return latest;
      };
      const run = await execute("verify", ["verify"], 2 * HOUR);
      const text = run.text();
      const failed = [
        ...(/verify: Error: (.*)$/m.exec(text)?.[1] ?? "").matchAll(/([\w-]+) failed \(/g),
      ].map((match) => match[1] as string);
      const failure = run.ok ? undefined : failureOf(run, text, failed);
      const result: VerifyResult = {
        ok: run.ok,
        log: run.log,
        durationMs: Date.now() - started,
        failed,
        excerpt: run.ok ? "" : excerptOf(text, failed),
        flaky: [],
        ...(run.ok
          ? {}
          : {
              failure:
                failure?.kind === "harness"
                  ? failure
                  : failed.some(
                        (label) =>
                          ![
                            "install",
                            "check",
                            "build",
                            "smoke",
                            "workflows",
                            ...Object.keys(ACCEPTANCE),
                          ].includes(label),
                      )
                    ? { kind: "harness" as const, reason: "unclassified_check_failure" }
                    : failureOf(run, text, failed),
            }),
      };
      if (
        result.ok ||
        result.failure?.kind === "harness" ||
        !failed.length ||
        !failed.every((label) => ACCEPTANCE[label])
      )
        return result;
      for (const label of failed) {
        let passed = false;
        for (let attempt = 0; attempt < 2 && !passed; attempt++) {
          await calm(options.signal);
          const retry = await execute(`verify-${label}`, [ACCEPTANCE[label] as string], HOUR);
          passed = retry.ok;
          if (!passed) {
            const failure = failureOf(retry, retry.text(), [label]);
            if (failure.kind === "harness")
              return {
                ...result,
                failure,
                log: retry.log,
                durationMs: Date.now() - started,
                excerpt: excerptOf(retry.text(), []),
              };
          }
        }
        if (!passed) return { ...result, durationMs: Date.now() - started };
        result.flaky.push(label);
      }
      const rest = await execute("verify-workflows", ["eval", "workflows"], HOUR);
      return rest.ok
        ? {
            ...result,
            ok: true,
            failure: undefined,
            failed: [],
            excerpt: "",
            durationMs: Date.now() - started,
          }
        : {
            ...result,
            failed: ["workflows"],
            failure: failureOf(rest, rest.text(), ["workflows"]),
            log: rest.log,
            excerpt: excerptOf(rest.text(), []),
            durationMs: Date.now() - started,
          };
    });
  } catch (error) {
    return {
      ok: false,
      log: latest?.log ?? "",
      durationMs: Date.now() - started,
      failed: [],
      excerpt: "",
      flaky: [],
      failure: {
        kind: "harness",
        reason:
          cleanupUnknown ||
          (error instanceof Error && error.message === "verify_cleanup_unconfirmed")
            ? "process_cleanup_unconfirmed"
            : options.signal.aborted
              ? "workflow_cancelled"
              : exceptionReason(error),
      },
    };
  }
}

async function calm(signal: AbortSignal) {
  const deadline = Date.now() + 20 * 60_000;
  while ((loadavg()[0] ?? 0) > availableParallelism() && Date.now() < deadline) {
    signal.throwIfAborted();
    process.stdout.write(`pibot-dev: load ${Math.round(loadavg()[0] ?? 0)}; waiting to rerun\n`);
    await delay(Math.min(60_000, deadline - Date.now()), undefined, { signal });
  }
  signal.throwIfAborted();
}
