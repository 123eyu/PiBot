import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  canonicalPath,
  ExecError,
  type ExecutionTarget,
  fileIdentity,
  matchesFileIdentity,
} from "@pibot/execution";
import { z } from "zod";
import { waitForResponse } from "./request-wait.ts";
import type { AcpClientPort } from "./types.ts";

const createTerminal = z.strictObject({ terminalId: z.string().min(1).max(4096) });
const terminalOutput = z.strictObject({
  output: z.string().max(1_100_000),
  truncated: z.boolean(),
  exitStatus: z
    .strictObject({
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const terminalExit = z.object({
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
});
const readText = z.strictObject({ content: z.string().max(64 * 1024 * 1024) });
const empty = z.object({}).passthrough();

type TerminalRecord = {
  sessionId: string;
  terminalId?: string;
  creating?: Promise<void>;
  abandoned?: boolean;
  running: boolean;
  cleanupState: "owned" | "kill_unconfirmed" | "release_unconfirmed";
  cleanup?: Promise<void>;
};

type TerminalCleanupWarning = {
  code: "terminal_cleanup_unconfirmed";
  phase: "command" | "release_run" | "dispose";
  killUnconfirmed: boolean;
};

export interface AcpExecutionTarget {
  target: ExecutionTarget;
  location: { target: `acp:${string}`; platform: "darwin" | "linux" | "win32" };
  bindClient(
    client: AcpClientPort,
    capabilities: { read: boolean; write: boolean; terminal: boolean },
  ): void;
  registerSession(sessionId: string, roots: readonly string[]): void;
  unregisterSession(sessionId: string): void;
  bindRun(runId: string, sessionId: string): void;
  releaseRun(runId: string): void;
}

function unsupported(): never {
  throw new ExecError("file_failed", "unsupported_platform");
}

/** Distinct from `unsupported`: the editor could enable this, so the Bot should say so. */
function capabilityMissing(code: "file_failed" | "command_failed"): never {
  throw new ExecError(code, "editor_capability_missing");
}

/**
 * Operations this target never implements. Brain withholds the matching tools from the model
 * instead of offering ones that can only fail.
 */
const UNSUPPORTED_OPERATIONS: ReadonlySet<keyof ExecutionTarget> = new Set([
  "startBackground",
  "writeBackground",
  "listDir",
  "readLog",
  "observeChanges",
  "findFiles",
  "searchText",
  "applyPatch",
  "readBinary",
  "writeBinary",
  "writeImage",
  "readCheckpoint",
]);

function inside(root: string, path: string, platform: "darwin" | "linux" | "win32") {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const base = fold(resolve(root));
  const candidate = fold(resolve(path));
  const separator = platform === "win32" ? "\\" : "/";
  return candidate === base || candidate.startsWith(`${base}${separator}`);
}

/**
 * ACP is a local stdio protocol, so canonical identity is checked in this Node process. Reads,
 * writes and commands themselves cross the editor's advertised ACP methods and never fall back to
 * local execution. The adapter is capability-gated and owns every terminal it creates.
 */
export function createAcpExecutionTarget(options: {
  id: string;
  platform: "darwin" | "linux" | "win32";
  warn?: (warning: TerminalCleanupWarning) => void;
}): AcpExecutionTarget {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.id)) throw new TypeError("Invalid ACP target id");
  let client: AcpClientPort | undefined;
  let capabilities = { read: false, write: false, terminal: false };
  const sessions = new Map<string, string[]>();
  const runs = new Map<string, string>();
  const terminals = new Map<string, TerminalRecord>();
  const pendingWrites = new Set<Promise<unknown>>();
  const lifetime = new AbortController();

  const current = () => {
    if (!client || lifetime.signal.aborted) throw new ExecError("closed");
    return client;
  };
  const sessionFor = (cwd: string, runId?: string) => {
    const bound = runId ? runs.get(runId) : undefined;
    if (bound && sessions.has(bound)) return bound;
    const matches = [...sessions].filter(([, roots]) =>
      roots.some((root) => inside(root, cwd, options.platform)),
    );
    const selected = matches.at(-1)?.[0];
    if (!selected) throw new ExecError("outside_workplace");
    return selected;
  };
  const verifyRoots = async (
    roots: { canonicalPath: string; device: string | null; inode: string | null }[] | undefined,
    signal: AbortSignal,
  ) => {
    for (const root of roots ?? []) {
      signal.throwIfAborted();
      const stat = await lstat(root.canonicalPath, { bigint: true });
      if (
        (await realpath(root.canonicalPath)) !== root.canonicalPath ||
        !matchesFileIdentity(stat, root)
      )
        throw new ExecError("outside_workplace");
    }
  };
  const checkedPath = async (path: string, cwd: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const absolute = await canonicalPath(path, cwd);
    const sessionId = sessionFor(cwd);
    const roots = sessions.get(sessionId) ?? [];
    if (!roots.some((root) => inside(root, absolute, options.platform)))
      throw new ExecError("outside_workplace");
    return { path: absolute, sessionId };
  };
  const request = async (method: string, params: unknown, signal: AbortSignal) => {
    const combined = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30_000)]);
    combined.throwIfAborted();
    const response = current().request(method, params, combined);
    if (method === "fs/write_text_file") {
      pendingWrites.add(response);
      void response.then(
        () => pendingWrites.delete(response),
        () => {
          // A transport failure cannot certify whether a dispatched write happened.
        },
      );
    }
    return waitForResponse(response, combined);
  };
  const cleanupRequest = (method: string, params: unknown, signal: AbortSignal) => {
    if (!client) return Promise.reject(new ExecError("closed"));
    // Cleanup must remain possible after lifetime cancellation, including late create receipts.
    return client.request(method, params, signal);
  };
  const cleanupTerminal = (
    runId: string,
    terminal: TerminalRecord,
    phase: TerminalCleanupWarning["phase"],
    requester: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  ) => {
    // Cleanup owners may converge here concurrently. Queue a fresh attempt after a failed one;
    // release success by an earlier owner makes later attempts no-ops.
    const previous = terminal.cleanup?.catch(() => undefined) ?? Promise.resolve();
    const cleanup = previous.then(async () => {
      if (terminals.get(runId) !== terminal) return;
      let killError: unknown;
      try {
        if (!terminal.terminalId && terminal.creating)
          await waitForResponse(terminal.creating, AbortSignal.timeout(5_000));
        if (!terminal.terminalId) throw new Error("ACP terminal creation is unconfirmed");
      } catch (error) {
        if (terminals.get(runId) !== terminal) return;
        options.warn?.({ code: "terminal_cleanup_unconfirmed", phase, killUnconfirmed: true });
        throw error;
      }
      if (terminal.running) {
        try {
          const signal = AbortSignal.timeout(5_000);
          const killed = requester(
            "terminal/kill",
            { sessionId: terminal.sessionId, terminalId: terminal.terminalId },
            signal,
          ).then(() => {
            terminal.running = false;
            terminal.cleanupState = "owned";
          });
          await waitForResponse(killed, signal);
        } catch (error) {
          killError = error;
          terminal.cleanupState = "kill_unconfirmed";
        }
      }
      try {
        // ACP defines successful release as terminating a still-running command and invalidating
        // its terminal id, so it is the sole fact that permits us to delete ownership.
        const signal = AbortSignal.timeout(5_000);
        const released = requester(
          "terminal/release",
          { sessionId: terminal.sessionId, terminalId: terminal.terminalId },
          signal,
        ).then(() => {
          if (terminals.get(runId) === terminal) {
            terminals.delete(runId);
            runs.delete(runId);
          }
        });
        await waitForResponse(released, signal);
      } catch (releaseError) {
        if (terminals.get(runId) !== terminal) return;
        terminal.cleanupState = "release_unconfirmed";
        options.warn?.({
          code: "terminal_cleanup_unconfirmed",
          phase,
          killUnconfirmed: killError !== undefined,
        });
        throw new AggregateError(
          killError === undefined ? [releaseError] : [killError, releaseError],
          "ACP terminal release was not confirmed",
        );
      }
    });
    terminal.cleanup = cleanup;
    void cleanup
      .finally(() => {
        if (terminal.cleanup === cleanup) terminal.cleanup = undefined;
      })
      .catch(() => {
        // The caller owns the original rejection; consume only finally's derived promise.
      });
    return cleanup;
  };

  const target: ExecutionTarget = {
    unsupportedOperations: UNSUPPORTED_OPERATIONS,
    async realpath(path, signal) {
      signal.throwIfAborted();
      const value = await realpath(path);
      signal.throwIfAborted();
      return value;
    },
    async canonicalizePath(path, cwd, signal) {
      const checked = await checkedPath(path, cwd, signal);
      const canonical = await realpath(checked.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return checked.path;
        throw error;
      });
      const stat = await lstat(canonical, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      signal.throwIfAborted();
      return {
        path: canonical,
        ...(stat ? fileIdentity(stat) : { device: null, inode: null }),
      };
    },
    async isolationStatus(signal) {
      signal?.throwIfAborted();
      return { available: false, reason: "acp_editor_terminal_unisolated" };
    },
    async runCommand(input) {
      if (!capabilities.terminal) capabilityMissing("command_failed");
      // The editor terminal is not Pi Bot's sandbox; there is nothing to leave here.
      if (Object.keys(input.secretEnv ?? {}).length || input.docker || input.outsideSandbox)
        unsupported();
      input.signal.throwIfAborted();
      await verifyRoots(input.rootIdentities, input.signal);
      input.assertDockerAuthorized?.();
      input.assertAuthorized?.();
      await input.confirmDispatch?.();
      const sessionId = sessionFor(input.cwd, input.runId);
      const shell = options.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const args =
        options.platform === "win32"
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command]
          : ["-lc", input.command];
      const started = Date.now();
      const bound = current();
      const terminal: TerminalRecord = {
        sessionId,
        running: true,
        cleanupState: "owned",
      };
      if (terminals.has(input.runId)) throw new Error("ACP terminal owner is still draining");
      // Register ownership before dispatch: dispose must also account for unknown terminal ids.
      terminals.set(input.runId, terminal);
      const createSignal = AbortSignal.any([
        input.signal,
        lifetime.signal,
        AbortSignal.timeout(30_000),
      ]);
      terminal.creating = bound
        .request(
          "terminal/create",
          { sessionId, command: shell, args, cwd: input.cwd, outputByteLimit: 1_048_576 },
          createSignal,
        )
        .then(
          (value) => {
            terminal.terminalId = createTerminal.parse(value).terminalId;
          },
          (error) => {
            // Transport rejection cannot certify that the editor did not create a terminal.
            // Keep the unknown owner as a failed drain rather than releasing its writer lease.
            throw error;
          },
        );
      void terminal.creating
        .then(async () => {
          if (terminal.abandoned || lifetime.signal.aborted)
            await cleanupTerminal(input.runId, terminal, "command", cleanupRequest);
        })
        .catch(() => {
          // Creation rejection is observed below; late cleanup failures retain identity and warn.
        });
      try {
        await waitForResponse(terminal.creating, createSignal);
        createSignal.throwIfAborted();
      } catch (error) {
        terminal.abandoned = true;
        await cleanupTerminal(input.runId, terminal, "command", cleanupRequest);
        throw error;
      }
      const created = { terminalId: terminal.terminalId as string };
      let previous = "";
      const timeout = AbortSignal.timeout((input.timeoutSec ?? 120) * 1000);
      const commandSignal = AbortSignal.any([input.signal, timeout, lifetime.signal]);
      let pollDelayMs = 100;
      let exitWait:
        | Promise<{ type: "exit"; status: z.infer<typeof terminalExit> } | { type: "unavailable" }>
        | undefined = request(
        "terminal/wait_for_exit",
        { sessionId, terminalId: created.terminalId },
        commandSignal,
      )
        .then((value) => ({ type: "exit" as const, status: terminalExit.parse(value) }))
        .catch(() => ({ type: "unavailable" as const }));
      try {
        while (true) {
          commandSignal.throwIfAborted();
          if (exitWait) {
            const status = await Promise.race([
              exitWait,
              wait(pollDelayMs, undefined, { signal: commandSignal }).then(() => undefined),
            ]);
            if (status?.type === "unavailable") {
              commandSignal.throwIfAborted();
              exitWait = undefined;
            } else if (status?.type === "exit") {
              terminal.running = false;
              const final = terminalOutput.parse(
                await request(
                  "terminal/output",
                  { sessionId, terminalId: created.terminalId },
                  commandSignal,
                ),
              );
              const next = final.output.startsWith(previous)
                ? final.output.slice(previous.length)
                : final.output;
              if (next) input.onOutput?.(next);
              previous = final.output;
              return {
                exitCode: status.status.exitCode ?? null,
                timedOut: false,
                stopped: false,
                durationMs: Date.now() - started,
                logPath: resolve(input.botHome, ".pibot", "acp", `${input.runId}.log`),
                truncatedOutput: final.output,
              };
            }
          } else await wait(pollDelayMs, undefined, { signal: commandSignal });
          const snapshot = terminalOutput.parse(
            await request(
              "terminal/output",
              { sessionId, terminalId: created.terminalId },
              commandSignal,
            ),
          );
          const next = snapshot.output.startsWith(previous)
            ? snapshot.output.slice(previous.length)
            : snapshot.output;
          if (next) input.onOutput?.(next);
          previous = snapshot.output;
          if (snapshot.exitStatus) {
            terminal.running = false;
            return {
              exitCode: snapshot.exitStatus.exitCode ?? null,
              timedOut: false,
              stopped: false,
              durationMs: Date.now() - started,
              logPath: resolve(input.botHome, ".pibot", "acp", `${input.runId}.log`),
              truncatedOutput: snapshot.output,
            };
          }
          pollDelayMs =
            snapshot.truncated || Buffer.byteLength(snapshot.output) >= 1_048_576
              ? Math.min(2_000, pollDelayMs * 2)
              : 100;
        }
      } catch (error) {
        if (!commandSignal.aborted) throw error;
        if (input.signal.aborted) input.signal.throwIfAborted();
        if (lifetime.signal.aborted) throw new ExecError("closed");
        return {
          exitCode: null,
          timedOut: timeout.aborted,
          stopped: false,
          durationMs: Date.now() - started,
          logPath: resolve(input.botHome, ".pibot", "acp", `${input.runId}.log`),
          truncatedOutput: previous,
        };
      } finally {
        await cleanupTerminal(input.runId, terminal, "command", cleanupRequest);
      }
    },
    async releaseRun(runId) {
      const terminal = terminals.get(runId);
      if (terminal) await cleanupTerminal(runId, terminal, "release_run", cleanupRequest);
      // ACP file requests have no run id. Conservatively retain every writer lease while any
      // dispatched write is unconfirmed, including after its local caller timed out.
      if (pendingWrites.size) throw new Error("ACP file write is unconfirmed");
      runs.delete(runId);
    },
    async startBackground() {
      unsupported();
    },
    async writeBackground() {
      unsupported();
    },
    background: {
      get: () => undefined,
      async killOrphans() {
        unsupported();
      },
    },
    async listDir() {
      unsupported();
    },
    async readFile(input) {
      if (!capabilities.read) capabilityMissing("file_failed");
      await verifyRoots(input.rootIdentities, input.signal);
      const checked = await checkedPath(input.path, input.cwd, input.signal);
      if (input.expectedPath && checked.path !== input.expectedPath)
        throw new ExecError("outside_workplace");
      const limit = input.limit ?? 2000;
      const result = readText.parse(
        await request(
          "fs/read_text_file",
          {
            sessionId: checked.sessionId,
            path: checked.path,
            line: (input.offset ?? 0) + 1,
            limit: limit + 1,
          },
          input.signal,
        ),
      );
      const lines = result.content.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
      const truncated = lines.length > limit;
      const text = lines.slice(0, limit).join("");
      return {
        path: checked.path,
        type: "text",
        size: Buffer.byteLength(text),
        text,
        truncated,
      };
    },
    readLog: async () => unsupported(),
    observeChanges: async () => unsupported(),
    findFiles: async () => unsupported(),
    searchText: async () => unsupported(),
    async writeFile(input) {
      if (!capabilities.write) capabilityMissing("file_failed");
      await verifyRoots(input.rootIdentities, input.signal);
      const checked = await checkedPath(input.path, input.cwd, input.signal);
      if (
        (input.expectedPath && checked.path !== input.expectedPath) ||
        !input.writeRoots.some((root) => inside(root, checked.path, options.platform)) ||
        input.denyWriteRoots?.some((root) => inside(root, checked.path, options.platform))
      )
        throw new ExecError("outside_workplace");
      input.signal.throwIfAborted();
      input.assertCurrent?.();
      await input.confirmDispatch?.();
      empty.parse(
        await request(
          "fs/write_text_file",
          { sessionId: checked.sessionId, path: checked.path, content: input.content },
          input.signal,
        ),
      );
      return { path: checked.path, bytes: Buffer.byteLength(input.content) };
    },
    async editFile(input) {
      if (input.edits) unsupported();
      if (!input.old || input.new === undefined) throw new ExecError("invalid_input");
      const before = await target.readFile({ ...input, offset: 0, limit: 2000 });
      if (before.type !== "text" || before.truncated) throw new ExecError("file_failed");
      const first = before.text.indexOf(input.old);
      if (first < 0) throw new ExecError("edit_not_unique");
      if (!input.replaceAll && before.text.indexOf(input.old, first + input.old.length) >= 0)
        throw new ExecError("edit_not_unique");
      const content = input.replaceAll
        ? before.text.split(input.old).join(input.new)
        : `${before.text.slice(0, first)}${input.new}${before.text.slice(first + input.old.length)}`;
      const result = await target.writeFile({ ...input, content });
      return { ...result, diff: `--- a/${input.path}\n+++ b/${input.path}\n` };
    },
    applyPatch: async () => unsupported(),
    readBinary: async () => unsupported(),
    writeBinary: async () => unsupported(),
    writeImage: async () => unsupported(),
    // The editor owns file contents, so no snapshot; but this process sees the same disk, and
    // saying a file inside the session does not exist yet lets a write show as new, not changed.
    async readCheckpoint(path, signal) {
      if (
        [...sessions.values()].some((roots) =>
          roots.some((root) => inside(root, path, options.platform)),
        )
      ) {
        const missing = await lstat(path).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        signal.throwIfAborted();
        if (missing) throw Object.assign(new Error("not_found"), { code: "ENOENT" });
      }
      return unsupported();
    },
    async dispose() {
      const bound = client;
      lifetime.abort();
      const closing = bound
        ? [...terminals].map(([runId, terminal]) =>
            cleanupTerminal(runId, terminal, "dispose", (method, params, signal) =>
              bound.request(method, params, signal),
            ),
          )
        : terminals.size
          ? [Promise.reject(new Error("ACP client unavailable during terminal cleanup"))]
          : [];
      const results = await Promise.allSettled(closing);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, "ACP terminal cleanup was not confirmed");
      if (pendingWrites.size) throw new Error("ACP file write is unconfirmed");
      sessions.clear();
      runs.clear();
      client = undefined;
    },
  };

  return {
    target,
    location: { target: `acp:${options.id}`, platform: options.platform },
    bindClient(value, next) {
      if (client) throw new Error("ACP client already bound");
      client = value;
      capabilities = next;
    },
    registerSession(sessionId, roots) {
      sessions.set(sessionId, [...new Set(roots.map((root) => resolve(root)))]);
    },
    unregisterSession(sessionId) {
      sessions.delete(sessionId);
      for (const [runId, owner] of runs) if (owner === sessionId) runs.delete(runId);
    },
    bindRun(runId, sessionId) {
      if (!sessions.has(sessionId)) throw new Error("Unknown ACP session");
      runs.set(runId, sessionId);
    },
    releaseRun(runId) {
      if (!terminals.has(runId)) runs.delete(runId);
    },
  };
}
