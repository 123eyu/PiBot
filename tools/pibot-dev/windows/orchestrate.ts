import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyTargetBinary } from "../../../apps/desktop/scripts/package/verify-target-binary.ts";
import { exceptionReason } from "../check-failure.ts";
import type { TaskRecord } from "../state.ts";
import { command } from "./command.ts";
import { commandReason, remoteReceipts, remoteRoot } from "./protocol.ts";
import {
  cleanupScript,
  deployScript,
  idleScript,
  prepareScript,
  uploadedDeployScript,
} from "./scripts.ts";
import {
  type CommandResult,
  WINDOWS_CHECKS,
  type WindowsTestOptions,
  type WindowsTestResult,
} from "./types.ts";

const MIN = 60_000;
class StageFailure extends Error {
  constructor(
    readonly reason: string,
    readonly outcome: "failed" | "harness_failed" = "harness_failed",
  ) {
    super(reason);
  }
}
export interface WindowsDependencies {
  dir: string;
  env: NodeJS.ProcessEnv;
  host: NodeJS.Platform;
  run?: typeof command;
}

/** The factory keeps probes away from real SSH, workflow state and packaging commands. */
export function createWindowsTester(deps: WindowsDependencies) {
  return async (task: TaskRecord, options: WindowsTestOptions = {}): Promise<WindowsTestResult> => {
    const runId = randomUUID();
    const log = join(deps.dir, "logs", `windows-${runId}.json`);
    const result: WindowsTestResult = {
      runId,
      log,
      arch: "x64",
      sourceDigest: /^v2:[a-f0-9]{64}$/.test(options.sourceDigest ?? "")
        ? options.sourceDigest
        : undefined,
      outcome: "harness_failed",
      detail: "windows_test_incomplete",
      stages: [],
    };
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(60 * MIN),
    ]);
    const run = deps.run ?? command;
    let temporary: string | undefined;
    let remote: string | undefined;
    let preparing = false;
    let activeStage = "preflight";
    const persist = async () => {
      await mkdir(join(deps.dir, "logs"), { recursive: true });
      await writeFile(
        `${log}.tmp`,
        `${JSON.stringify({ ...result, remoteRoot: remote, remoteTask: `PiBotDevTest-${runId}` }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(`${log}.tmp`, log);
    };
    const execute = async (
      stage: string,
      executable: string,
      args: string[],
      timeoutMs: number,
      current = signal,
      environment = deps.env,
    ) => {
      activeStage = stage;
      const started = Date.now();
      const value = await run(executable, args, {
        signal: current,
        timeoutMs,
        cwd: task.worktree,
        env: environment,
      });
      const reason = commandReason(value);
      result.stages.push({
        stage,
        outcome: reason ? "harness_failed" : "ok",
        reason: reason ?? "command_completed",
        durationMs: Date.now() - started,
        exitCode: value.code,
      });
      await persist();
      return value;
    };
    const ssh = (stage: string, args: string[], timeoutMs: number, current = signal) =>
      execute(
        stage,
        "ssh",
        ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "win", ...args],
        timeoutMs,
        current,
      );
    const powershell = (stage: string, script: string, timeoutMs: number, current = signal) =>
      ssh(
        stage,
        [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        timeoutMs,
        current,
      );
    const requireCommand = (value: CommandResult) => {
      const reason = commandReason(value);
      if (reason) throw new StageFailure(reason);
    };
    const readRemote = (value: CommandResult) => {
      if (!value.drained || value.stopped || value.signal || value.errorCode) requireCommand(value);
      const rows = remoteReceipts(value, runId);
      for (const row of rows)
        result.stages.push({
          stage: row.stage,
          outcome: row.outcome,
          reason: row.reason,
          durationMs: 0,
        });
      const failure = rows.find(
        (row) => row.outcome === "harness_failed" || row.outcome === "failed",
      );
      if (failure)
        throw new StageFailure(failure.reason, failure.outcome as "failed" | "harness_failed");
      requireCommand(value);
      return rows;
    };
    const idle = async () => {
      const rows = readRemote(await powershell("idle-query", idleScript(runId), 30_000));
      if (rows.length !== 1 || rows[0]?.stage !== "idle")
        throw new StageFailure("idle_receipt_missing");
      return rows[0].outcome === "skipped";
    };
    try {
      if (deps.host !== "darwin") throw new StageFailure("workflow_host_unsupported");
      if (!/^v2:[a-f0-9]{64}$/.test(options.sourceDigest ?? ""))
        throw new StageFailure("source_identity_required");
      if (!options.checks?.length) throw new StageFailure("windows_checks_not_specified");
      if (
        options.checks.length !== WINDOWS_CHECKS.length ||
        WINDOWS_CHECKS.some((check) => !options.checks?.includes(check))
      )
        throw new StageFailure("windows_checks_unsupported");
      signal.throwIfAborted();
      const reach = await ssh("connect", ["exit"], 15_000);
      if (
        reach.drained &&
        reach.code === 255 &&
        !reach.errorCode &&
        !reach.signal &&
        !reach.stopped
      ) {
        result.outcome = "skipped";
        result.detail = "windows_ssh_unreachable";
      } else {
        requireCommand(reach);
        if (await idle()) {
          result.outcome = "skipped";
          result.detail = "owner_busy";
        } else {
          requireCommand(
            await execute(
              "package",
              "pnpm",
              ["--filter", "@pibot/desktop", "package", "--win", "--x64", "--test", "--dir"],
              30 * MIN,
            ),
          );
          const unpacked = join(
            task.worktree,
            "apps",
            "desktop",
            "dist",
            "win-x64",
            "win-unpacked",
          );
          activeStage = "artifact";
          verifyTargetBinary(join(unpacked, "Pi Bot.exe"), "win32", "x64");
          temporary = await mkdtemp(join(deps.dir, "windows-"));
          const archive = join(temporary, "application.tgz");
          requireCommand(
            await execute(
              "archive",
              "tar",
              ["-czf", archive, "-C", join(unpacked, ".."), "win-unpacked"],
              3 * MIN,
              signal,
              { ...deps.env, COPYFILE_DISABLE: "1" },
            ),
          );
          const hash = createHash("sha256");
          for await (const bytes of createReadStream(archive, { signal })) hash.update(bytes);
          result.artifactHash = hash.digest("hex");
          // Packaging can take half an hour. Recheck immediately before touching the VM.
          if (await idle()) {
            result.outcome = "skipped";
            result.detail = "owner_busy";
          } else {
            preparing = true;
            const rows = readRemote(
              await powershell("prepare", prepareScript(runId, result.artifactHash), 30_000),
            );
            if (rows.length !== 1 || rows[0]?.stage !== "prepare")
              throw new StageFailure("prepare_receipt_missing");
            remote = remoteRoot(rows[0], runId);
            await persist();
            requireCommand(
              await execute(
                "upload",
                "scp",
                [
                  "-s",
                  "-q",
                  "-o",
                  "ConnectTimeout=5",
                  "-o",
                  "BatchMode=yes",
                  archive,
                  `win:${remote.replaceAll("\\", "/")}/application.tgz`,
                ],
                20 * MIN,
              ),
            );
            const script = Buffer.from(
              deployScript(runId, remote, result.artifactHash, options.checks),
              "utf8",
            );
            const scriptHash = createHash("sha256").update(script).digest("hex");
            const scriptFile = join(temporary, "deploy.ps1");
            await writeFile(scriptFile, script, { mode: 0o600, signal });
            requireCommand(
              await execute(
                "upload-script",
                "scp",
                [
                  "-s",
                  "-q",
                  "-o",
                  "ConnectTimeout=5",
                  "-o",
                  "BatchMode=yes",
                  scriptFile,
                  `win:${remote.replaceAll("\\", "/")}/deploy.ps1`,
                ],
                MIN,
              ),
            );
            const checked = readRemote(
              await powershell(
                "windows-checks",
                uploadedDeployScript(runId, remote, result.artifactHash, scriptHash),
                5 * MIN,
              ),
            );
            if (
              checked.length !== WINDOWS_CHECKS.length + 2 ||
              checked.filter((row) => row.stage === "deploy" && row.outcome === "ok").length !== 1
            )
              throw new StageFailure("functional_receipt_missing");
            if (
              !WINDOWS_CHECKS.every(
                (check) =>
                  checked.filter((row) => row.stage === check && row.outcome === "ok").length === 1,
              )
            )
              throw new StageFailure("functional_receipt_missing");
            if (!checked.some((row) => row.stage === "cleanup" && row.outcome === "ok"))
              throw new StageFailure("cleanup_receipt_missing");
            result.outcome = "ok";
            result.detail = "windows_checks_passed";
          }
        }
      }
    } catch (error) {
      result.outcome = error instanceof StageFailure ? error.outcome : "harness_failed";
      result.detail = error instanceof StageFailure ? error.reason : exceptionReason(error);
      result.stages.push({
        stage: activeStage,
        outcome: result.outcome,
        reason: result.detail,
        durationMs: 0,
      });
    } finally {
      // Cleanup has its own bounded signal: an aborted caller must not skip resource reclamation.
      if (preparing && result.artifactHash) {
        try {
          const value = await powershell(
            "cleanup-retry",
            cleanupScript(runId, remote, result.artifactHash),
            2 * MIN,
            AbortSignal.timeout(2 * MIN),
          );
          const rows = readRemote(value);
          if (rows.length !== 1 || rows[0]?.stage !== "cleanup" || rows[0]?.outcome !== "ok") {
            result.outcome = "harness_failed";
            result.detail = "cleanup_receipt_missing";
          }
        } catch {
          result.outcome = "harness_failed";
          result.detail = "remote_cleanup_unconfirmed";
          result.stages.push({
            stage: "cleanup",
            outcome: "harness_failed",
            reason: result.detail,
            durationMs: 0,
          });
        }
      }
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        result.outcome = "harness_failed";
        result.detail = "local_cleanup_unconfirmed";
      }
    }
    if (result.outcome === "ok" && signal.aborted) {
      result.outcome = "harness_failed";
      result.detail = options.signal?.aborted ? "workflow_cancelled" : "workflow_timeout";
    }
    try {
      await persist();
    } catch {
      throw new Error("windows_receipt_write_failed");
    }
    return result;
  };
}
