import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Cdp } from "../dev/cdp/cdp.ts";
import type { CdpIdentity } from "../dev/cdp/identity.ts";
import type { MacArtifact } from "./app-artifact.ts";
import { inspectMacArtifactAsync } from "./app-artifact-async.ts";
import { pnpmEnv, store } from "./context.ts";
import { launchMacCopy, stopMacCopy } from "./mac-test-process.ts";
import type { TaskRecord } from "./state.ts";
import { command } from "./windows/command.ts";

export const macTestLog = (runId: string) => join(store.dir, "logs", `mac-test-${runId}.json`);

export interface MacTestResult {
  ok: boolean;
  results: { flow: string; ok: boolean; output: string }[];
  shots: string;
  artifact: MacArtifact;
  runId: string;
}
async function freePort(preferred?: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferred ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mac_test_port_invalid");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function ready(data: string, since: string, signal: AbortSignal) {
  const started = Date.parse(since);
  for (;;) {
    signal.throwIfAborted();
    for (const day of new Set([since.slice(0, 10), new Date().toISOString().slice(0, 10)])) {
      let text: string;
      try {
        const file = join(data, "gui-logs", `${day}.log`),
          info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
          throw new Error("mac_test_log_invalid");
        text = await readFile(file, { encoding: "utf8", signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const line of text.split("\n")) {
        try {
          const row = JSON.parse(line);
          if (Date.parse(row.timestamp) < started || !Number.isFinite(Date.parse(row.timestamp)))
            continue;
          if (row.event === "gui_first_screen_ready") return;
          if (
            typeof row.message === "string" &&
            JSON.parse(row.message)?.event === "gui_first_screen_ready"
          )
            return;
        } catch {
          /* Incomplete trailing log lines cannot establish readiness. */
        }
      }
    }
    await delay(100, undefined, { signal });
  }
}
const same = (a: MacArtifact, b: MacArtifact) =>
  a.digest === b.digest && a.arch === b.arch && a.version === b.version;

/** No existing bundle/process/data is adopted or stopped: every target is this attempt's own copy. */
export async function testMacCopy(
  task: TaskRecord,
  flows: string[],
  preferredPort?: number,
  caller?: AbortSignal,
  attemptId?: string,
): Promise<MacTestResult> {
  if (process.platform !== "darwin") throw new Error("mac_test_host_unsupported");
  if (!/^[a-z0-9-]+$/.test(task.id) || (attemptId && !/^[a-f0-9-]{36}$/.test(attemptId)))
    throw new Error("mac_test_identity_invalid");
  const signal = AbortSignal.any([
    caller ?? new AbortController().signal,
    AbortSignal.timeout(60 * 60_000),
  ]);
  signal.throwIfAborted();
  const source = join(
    task.worktree,
    "apps",
    "desktop",
    "dist",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Pi Bot.app",
  );
  // Read the package receipt without running the synchronous inspector in this cancellable path.
  const receiptFile = join(task.worktree, "apps", "desktop", "dist", ".pibot-mac-artifact.json");
  const receiptInfo = await lstat(receiptFile);
  if (
    !receiptInfo.isFile() ||
    receiptInfo.isSymbolicLink() ||
    receiptInfo.size > 65536 ||
    (await realpath(receiptFile)) !== resolve(receiptFile)
  )
    throw new Error("mac_test_artifact_unavailable");
  const saved = JSON.parse(
    await readFile(join(task.worktree, "apps", "desktop", "dist", ".pibot-mac-artifact.json"), {
      encoding: "utf8",
      signal,
    }),
  ) as MacArtifact;
  const artifact = await inspectMacArtifactAsync(source, signal);
  if (saved.path !== source || !same(saved, artifact))
    throw new Error("mac_test_artifact_unavailable");
  await mkdir(store.dir, { recursive: true });
  const root = await mkdtemp(join(store.dir, "m-")),
    app = join(root, "Pi Bot.app"),
    data = join(root, "d"),
    runId = attemptId ?? randomUUID();
  const shots = join(store.dir, "shots", task.id, runId);
  const children: { ended: Promise<void> }[] = [];
  let copyDrained = true,
    runnerDrained = true;
  let launched = false,
    cleaned = false,
    success = false;
  const results: MacTestResult["results"] = [];
  const cleanup = async () => {
    const cleanupSignal = AbortSignal.timeout(30_000);
    if (!copyDrained) throw new Error("mac_test_copy_unconfirmed");
    if (launched) await stopMacCopy(app, cleanupSignal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("mac_test_cleanup_unconfirmed"));
      cleanupSignal.addEventListener("abort", abort, { once: true });
      Promise.all(children.map((child) => child.ended)).then(() => {
        cleanupSignal.removeEventListener("abort", abort);
        resolve();
      }, reject);
      if (cleanupSignal.aborted) abort();
    });
    if (!runnerDrained) throw new Error("mac_test_runner_cleanup_unconfirmed");
    cleaned = true;
  };
  const log = async (phase: string) => {
    await mkdir(join(store.dir, "logs"), { recursive: true });
    await writeFile(
      macTestLog(runId),
      `${JSON.stringify({ runId, phase, app, data, shots, artifactDigest: artifact.digest })}\n`,
      { mode: 0o600 },
    );
  };
  await log("preparing");
  let outcome: MacTestResult | undefined;
  let failure: unknown;
  try {
    const copy = await command("/usr/bin/ditto", [artifact.path, app], {
      signal,
      timeoutMs: 120_000,
    });
    if (!copy.drained) {
      copyDrained = false;
      throw new Error("mac_test_copy_unconfirmed");
    }
    if (copy.code !== 0 || copy.signal || copy.errorCode || copy.stopped)
      throw new Error("mac_test_copy_failed");
    if (!same(artifact, await inspectMacArtifactAsync(app, signal)))
      throw new Error("mac_test_artifact_changed");
    await mkdir(data);
    await mkdir(shots, { recursive: true });
    const start = async (debug: boolean) => {
      signal.throwIfAborted();
      const since = new Date().toISOString();
      const port = debug ? await freePort(preferredPort) : undefined;
      const args = debug
        ? [
            "--enable-automation",
            `--pibot-test-run=${runId}`,
            `--user-data-dir=${join(data, "gui-instance")}`,
            `--remote-debugging-port=${port}`,
            "--remote-debugging-address=127.0.0.1",
          ]
        : [];
      // Set ownership before spawn: a launch error still runs cleanup of this private target.
      launched = true;
      cleaned = false;
      const child = await launchMacCopy(
        join(app, "Contents", "MacOS", "Pi Bot"),
        args,
        data,
        signal,
      );
      children.push(child);
      const waiting = new AbortController();
      try {
        await Promise.race([
          ready(
            data,
            since,
            AbortSignal.any([signal, waiting.signal, AbortSignal.timeout(180_000)]),
          ),
          child.ended.then(() => {
            throw new Error("mac_test_early_exit");
          }),
        ]);
      } finally {
        waiting.abort();
      }
      return { child, port };
    };
    await start(false);
    await cleanup();
    signal.throwIfAborted();
    const db = new DatabaseSync(join(data, "pibot.db"));
    try {
      const put = db.prepare(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      put.run("onboardingCompleted", "true");
      put.run("language", JSON.stringify("zh"));
    } finally {
      db.close();
    }
    const { child, port } = await start(true);
    const identity: CdpIdentity = {
      pid: child.pid,
      executable: join(app, "Contents", "MacOS", "Pi Bot"),
      dataDir: data,
      runId,
      port: port as number,
      artifactDigest: artifact.digest,
    };
    const identityFile = join(root, "identity.json");
    await writeFile(identityFile, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
    const cdp = await Cdp.attachOwned(
      identity,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    );
    cdp.close();
    // The scripted UI walkthrough uses the UI driver from the private development repository; a
    // public checkout keeps the install, launch and CDP checks above and skips the flows.
    const driver = existsSync("tools/ui-driver/index.ts");
    for (let index = 0; driver && index < flows.length; index++) {
      signal.throwIfAborted();
      const flow = flows[index] as string;
      const output = join(shots, String(index));
      const args = flow.endsWith(".ts")
        ? ["--flow", "acceptance", "--script", flow]
        : ["--flow", flow];
      const result = await command(
        process.execPath,
        [
          "--import",
          "./tools/dev/ts-hooks.mjs",
          "tools/ui-driver/index.ts",
          "--port",
          String(port),
          "--identity",
          identityFile,
          "--output",
          output,
          ...args,
        ],
        { cwd: task.worktree, env: pnpmEnv, timeoutMs: 15 * 60_000, signal },
      );
      if (!result.drained) {
        runnerDrained = false;
        throw new Error("mac_test_runner_cleanup_unconfirmed");
      }
      signal.throwIfAborted();
      const ok = result.code === 0 && !result.signal && !result.errorCode && !result.stopped;
      results.push({
        flow,
        ok,
        output: ok ? "passed" : result.stopped ? `runner_${result.stopped}` : "runner_failed",
      });
      if (result.errorCode || result.signal || result.stopped)
        throw new Error("mac_test_runner_failed");
    }
    await cleanup();
    signal.throwIfAborted();
    if (
      !same(artifact, await inspectMacArtifactAsync(app, signal)) ||
      !same(artifact, await inspectMacArtifactAsync(artifact.path, signal))
    )
      throw new Error("mac_test_artifact_changed");
    success = results.length > 0 && results.every((row) => row.ok);
    outcome = { ok: success, results, shots, artifact, runId };
  } catch (error) {
    failure = error;
  }
  try {
    if (!cleaned) await cleanup();
  } catch {
    await log("cleanup_unconfirmed");
    throw new Error("mac_test_cleanup_unconfirmed");
  }
  await log(success ? "completed" : "failed");
  // Unconfirmed cleanup throws before removal; failed attempts retain their private diagnostics.
  if (success) await rm(root, { recursive: true, force: true });
  else await rm(app, { recursive: true, force: true });
  if (failure) throw failure;
  if (!outcome) throw new Error("mac_test_failed");
  return outcome;
}
