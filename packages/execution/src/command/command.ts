import { withDeadline } from "../core/deadline.ts";
import {
  type BackgroundStartOptions,
  ExecError,
  type ExecOptions,
  type RunCommandOptions,
} from "../core/types.ts";
import type { GitInitialization } from "../git/git-init-args.ts";
import { createSandboxProfiles } from "../sandbox/sandbox-profiles.ts";
import { createViolationMonitor } from "../sandbox/violation-monitor.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { type BackgroundProcessRecord, createBackgroundJobs } from "./background.ts";
import type { CommandDependencies } from "./command-context.ts";
import { commandFailure } from "./command-diagnostics.ts";
import { createCommandLauncher } from "./command-launch.ts";
import { createCommandRunner } from "./command-run.ts";
import { createCommandTemps } from "./command-temp.ts";
import { commandEnvironment } from "./environment.ts";
import { UnsafeSandboxEnvironmentError } from "./host-environment.ts";
import { commandDeadline } from "./run-deadline.ts";
import { secretOutputRedactor } from "./secret-output.ts";

/** How long a command whose caller gave up may take to confirm its own cleanup. */
const CLEANUP_GRACE_MS = 10_000;

/** One owner per brain; each isolated command runs in its own SRT host process. */
export function createExec(options: ExecOptions) {
  // The SDK uses these settings from its actual host environment; removing them only from a
  // snapshot would leave debug output or the TMPDIR override active.
  UnsafeSandboxEnvironmentError.assertSafe(options.env);
  const sandbox = createSandboxProfiles(options);
  const temps = createCommandTemps(options.tempDir);
  const violations = createViolationMonitor(options.platform, options.helperArgs?.violations);
  const lifetime = new AbortController();
  // ps / lsof / PowerShell for the background monitor run with the same clean environment.
  const toolEnv = () =>
    commandEnvironment(options.platform, options.env, options.systemHome, options.tempDir);
  const background = createBackgroundJobs({
    platform: options.platform,
    env: toolEnv,
    redactor: options.redactor,
    ...(options.onBackgroundDrain ? { onDrain: options.onBackgroundDrain } : {}),
    onMonitorFailure: (id) =>
      commandFailure(
        options,
        { runId: id, stage: "dispatch", readonlyRoots: 0 },
        new ExecError("command_failed", "listener_check_failed"),
      ),
  });
  const active = new Map<Promise<unknown>, string | undefined>();
  /** Commands whose cleanup is still unconfirmed after their caller gave up. */
  const unconfirmed = new Set<ExecError>();
  const retiringRuns = new Map<string, Promise<void>>();
  let closing: Promise<void> | undefined;
  const promoted = new Map<string, import("./background.ts").BackgroundJob>();
  const dependencies: CommandDependencies = {
    options,
    sandbox,
    temps,
    violations,
    lifetime,
    background,
    failDrain(error, jobId, record) {
      background.failDrain(error, jobId, record);
    },
    // The background instance owns the retry; a copy here would outlive its recovery.
    drainFailed: () => background.drainFailed(),
    retainCommand(work, runId) {
      temps.pin(runId);
      track(
        work
          .catch((error: unknown) => {
            if (error instanceof ExecError && error.reason === "cleanup_failed")
              background.failDrain(error);
            throw error;
          })
          .finally(() => {
            if (!background.drainFailed()) temps.unpin(runId);
          }),
        runId,
      );
    },
    adoptForeground(job) {
      promoted.set(job.id, job);
      void job.ended.then(
        () => promoted.delete(job.id),
        () => {
          if (!background.drainFailed())
            background.failDrain(new ExecError("command_failed", "cleanup_failed"));
        },
      );
    },
  };
  const run = createCommandRunner(dependencies);
  const launch = createCommandLauncher(dependencies);
  /**
   * A caller that gave up (deadline, cancel, dropped link) leaves the command's own
   * cleanup running. Blocking the whole executor until a restart stranded every later command, so
   * new commands wait only while this cleanup stays unconfirmed, and the pause ends by itself.
   */
  function pauseUntilSettled(work: Promise<unknown>) {
    const error = new ExecError("command_failed", "cleanup_unconfirmed");
    void withDeadline(work, CLEANUP_GRACE_MS, error).catch((failure: unknown) => {
      // Only the deadline proves the cleanup is unconfirmed; a settled command reported its own.
      if (failure !== error) return;
      unconfirmed.add(error);
      const settled = () => void unconfirmed.delete(error);
      void work.then(settled, settled);
    });
  }
  function track<T>(operation: Promise<T>, runId?: string) {
    active.set(operation, runId);
    void operation
      .finally(() => active.delete(operation))
      .catch(() => {
        /* The operation's caller receives the failure; ownership lasts until actual settlement. */
      });
    return operation;
  }
  function available(runId?: string) {
    background.assertHealthy();
    // A cleanup still in progress pauses new commands, but only while it is really unconfirmed.
    const paused = unconfirmed.values().next();
    if (!paused.done) throw paused.value;
    if (lifetime.signal.aborted || (runId && retiringRuns.has(runId)))
      throw new ExecError("closed");
  }
  return {
    activitySnapshot: () => ({
      runningCommands: active.size,
      backgroundTasks: background.activeCount(),
    }),
    async isolationStatus(signal?: AbortSignal) {
      available();
      try {
        return await sandbox.isolationStatus(signal);
      } catch (error) {
        if (error instanceof ExecError && error.reason === "cleanup_failed")
          background.failDrain(error);
        throw error;
      }
    },
    runCommand(input: RunCommandOptions & { gitInitialization?: GitInitialization }) {
      available(input.runId);
      const commandLifetime = new AbortController();
      const signal = AbortSignal.any([input.signal, lifetime.signal, commandLifetime.signal]);
      if (
        input.secretOutput?.length &&
        (input.promotion || input.docker || input.gitHook || input.gitOutput || input.hostSsh)
      )
        throw new ExecError("invalid_input");
      const execute = input.secretOutput?.length
        ? createCommandRunner({
            ...dependencies,
            options: {
              ...options,
              redactor: secretOutputRedactor(options.redactor, input.secretOutput),
            },
          })
        : run;
      temps.pin(input.runId);
      const raw = execute({ ...input, signal })
        .catch((error: unknown) => {
          if (error instanceof ExecError && error.reason === "cleanup_failed")
            background.failDrain(error);
          throw error;
        })
        .finally(() => {
          if (!background.drainFailed()) temps.unpin(input.runId);
        });
      track(raw, input.runId);
      return commandDeadline(raw, input.timeoutSec, signal, commandLifetime).catch(
        (error: unknown) => {
          if (active.has(raw)) pauseUntilSettled(raw);
          throw error;
        },
      );
    },
    writeBackground(input: {
      jobId: string;
      runId: string;
      text: string;
      eof: boolean;
      rootIdentities: RunCommandOptions["rootIdentities"];
      signal: AbortSignal;
      assertAuthorized(): void | Promise<void>;
    }) {
      available(input.runId);
      const signal = AbortSignal.any([input.signal, lifetime.signal, AbortSignal.timeout(15_000)]);
      return track(
        (async () => {
          await verifyWorkspace(input.rootIdentities, signal);
          const job = background.get(input.jobId);
          if (!job) throw new ExecError("closed");
          return job.writeInput(input.text, input.eof, signal, input.assertAuthorized);
        })().catch((error: unknown) => {
          if (error instanceof ExecError && error.reason === "cleanup_failed")
            background.failDrain(error);
          throw error;
        }),
        input.runId,
      );
    },
    startBackground(input: BackgroundStartOptions) {
      if (input.gitHook || input.hostSsh || input.gitOutput) throw new ExecError("invalid_input");
      if (input.docker) throw new ExecError("docker_unsupported");
      available(input.runId);
      const startup = new AbortController();
      const signal = AbortSignal.any([input.signal, lifetime.signal, startup.signal]);
      const raw = track(launch({ ...input, signal }), input.runId);
      // A stuck filesystem/startup callback cannot hang the tool forever or certify idle.
      return commandDeadline(raw, 60, signal, startup).catch((error: unknown) => {
        if (!active.has(raw)) throw error;
        pauseUntilSettled(raw);
        throw new ExecError("command_failed", "cleanup_unconfirmed");
      });
    },
    /** The run ended: its commands' private temp folder goes (idempotent). */
    releaseRun(runId: string): Promise<void> {
      const previous = retiringRuns.get(runId);
      if (previous) return previous;
      const released = (async () => {
        await Promise.allSettled(
          [...active].filter(([, owner]) => owner === runId).map(([work]) => work),
        );
        if (background.drainFailed()) background.assertHealthy();
        await temps.releaseRun(runId);
      })().finally(() => retiringRuns.delete(runId));
      retiringRuns.set(runId, released);
      return released;
    },
    background: {
      get: (id: string) => promoted.get(id) ?? background.get(id),
      /** Brain restart: stop processes a previous brain recorded (idempotent). */
      killOrphans: (records: BackgroundProcessRecord[], signal: AbortSignal) =>
        background.killOrphans(records, signal),
    },
    dispose(): Promise<void> {
      closing ??= (async () => {
        lifetime.abort();
        try {
          await withDeadline(
            Promise.allSettled([...active.keys()]),
            10_000,
            new ExecError("command_failed", "cleanup_failed"),
          );
        } catch (error) {
          if (!background.drainFailed())
            background.failDrain(new ExecError("command_failed", "cleanup_failed"));
          throw error;
        }
        // Before the sandbox goes: its proxy and runtime belong to these processes too.
        try {
          await background.dispose();
        } finally {
          violations.dispose();
          await sandbox.dispose();
        }
        background.assertHealthy();
        await temps.dispose();
      })();
      return closing;
    },
  };
}
