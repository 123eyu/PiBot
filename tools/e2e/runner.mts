import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Cdp } from "../dev/cdp/cdp.ts";
import { Page } from "../dev/cdp/page.ts";
import { startFakeLlm } from "../fake-llm/index.ts";
import { loadScenario } from "../fake-llm/scenario.ts";
import { Context, type StepResult } from "./context.mts";
import {
  cleanEnv,
  confirmWriterExit,
  freePort,
  launch,
  noSecrets,
  stopChild,
  until,
} from "./util.mts";

export const flows = [
  "browser-login",
  "teach-once",
  "routine-run",
  "connector-mcp",
  "approval-yolo",
  "compact-manual",
  "browser-secret",
] as const;
export type FlowName = (typeof flows)[number];
export const repo = resolve(import.meta.dirname, "../..");

export async function build(signal: AbortSignal) {
  const manager = process.env.npm_execpath;
  assert(manager, "run_with_pnpm");
  // npm_execpath is a JS entry for npm/corepack-installed pnpm but a native binary for standalone
  // pnpm (12.x); only run it through Node when it is a script.
  const script = /\.(c|m)?js$/.test(manager);
  const child = spawn(
    script ? process.execPath : manager,
    script ? [manager, "build"] : ["build"],
    {
      cwd: repo,
      stdio: "inherit",
      env: cleanEnv(),
      signal,
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("e2e_build_failed"))));
  });
}

async function writerPids(data: string) {
  let descriptor: { pid: number; utilityPid: number | null };
  try {
    descriptor = JSON.parse(await readFile(join(data, "background-runtime", "owner.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const pids = [descriptor.pid, descriptor.utilityPid].filter((pid) => pid !== null);
  assert(
    pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
    "invalid_writer_pid",
  );
  return pids;
}

export async function runFlow(name: FlowName, output: string, lifetime: AbortSignal, keep = false) {
  // A short macOS path is required by the existing owner's Unix socket limit.
  const root = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pbe-")),
  );
  const data = join(root, "data"),
    out = join(output, name);
  await mkdir(data, { mode: 0o700 });
  await mkdir(out, { recursive: true, mode: 0o700 });
  const report = async (result: StepResult) => {
    console.log(JSON.stringify(result));
    await appendFile(join(output, "steps.jsonl"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  };
  const children: ChildProcess[] = [];
  if (keep)
    await report({
      flow: name,
      step: "temporary-data",
      ok: true,
      temporaryDirectory: root,
      logs: [join(data, "e2e-owner.log"), join(data, "e2e-gui.log")],
    });
  let cdp: Cdp | undefined, context: Context | undefined;
  let llm: Awaited<ReturnType<typeof startFakeLlm>> | undefined;
  let passed = false,
    cleanupConfirmed = false;
  try {
    const entry = join(repo, "apps", "desktop", "out", "main", "index.js");
    await readFile(entry); // Fail before launching if the build is missing.
    await cp(join(repo, "tools", "e2e", "fixtures"), join(root, "fixtures"), {
      recursive: true,
    });
    const scenario = await loadScenario(`e2e-${name}`);
    let requestBytes = 0,
      leaked = false;
    llm = await startFakeLlm({
      port: 0,
      scenario,
      logDirectory: join(root, "fake-log"),
      observe: (body) => {
        if (context) context.modelRequests++;
        context?.observeFixture(body);
        const text = JSON.stringify(body);
        if (context) {
          context.requestTexts.push(text);
          if (context.requestTexts.length > 50) context.requestTexts.shift();
          context.onRequest?.(text);
        }
        requestBytes += Buffer.byteLength(text);
        if (requestBytes > 16 * 1024 * 1024) throw new Error("e2e_request_capture_limit");
        if (context?.secrets.some((secret) => text.includes(secret))) leaked = true;
      },
    });
    const require = createRequire(join(repo, "apps", "desktop", "package.json"));
    const electron: string = require("electron");
    const guiPort = await freePort();
    let ownerPort = guiPort;
    const env = { ...cleanEnv(), PIBOT_DATA_DIR: data };
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(240_000)]);
    const args = (port: number) => [
      join(repo, "apps", "desktop"),
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
    ];
    if (process.platform !== "win32") {
      ownerPort = await freePort();
      children.push(
        launch(
          electron,
          // A GUI-spawned owner carries --pibot-from-gui; without it the owner treats this start as
          // a login launch and holds the keychain for a 30 s grace window, so setup saves fail.
          [...args(ownerPort), "--pibot-background", "--pibot-from-gui"],
          env,
          repo,
          join(data, "e2e-owner.log"),
        ).child,
      );
      // Starting the owner ourselves gives its Bot browser targets a private CDP endpoint.
      await until(
        "owner_ready",
        () =>
          readFile(join(data, "background-runtime", "owner.json"), "utf8")
            .then((text) => JSON.parse(text))
            .catch(() => null),
        (value) => Number.isInteger(value?.utilityPid),
        signal,
        45000,
      );
    }
    children.push(launch(electron, args(guiPort), env, repo, join(data, "e2e-gui.log")).child);
    cdp = await Cdp.target(guiPort, (url) => /renderer\/index\.html/.test(url), 60000);
    const page = new Page(cdp, out);
    await page.start({ waitForApp: false });
    context = new Context(name, page, scenario, root, data, out, ownerPort, signal, report);
    const active = context;
    const modelUrl = llm.url;
    await context.step("initialize", () => active.initialize(modelUrl));
    const flow = await import(`./flows/${name}.mts`);
    await flow.run(context);
    await context.step("renderer-errors", async () => {
      assert.equal(page.errors.length, 0, "renderer_console_errors");
    });
    assert(!leaked, "e2e_password_in_model_request");
    passed = true;
  } catch (error) {
    const screenshot = await cdp
      ?.send<{ data: string }>("Page.captureScreenshot", { format: "png" })
      .then(async (shot) => {
        const { writeFile } = await import("node:fs/promises");
        const path = join(out, "failure.png");
        await writeFile(path, Buffer.from(shot.data, "base64"));
        return path;
      })
      .catch(() => undefined);
    // Values, prompts, form fields and database bytes never appear in the persistent report.
    const raw = error instanceof Error ? error.message : "e2e_failure";
    const reason = (context?.secrets ?? [])
      .reduce((s, secret) => s.replaceAll(secret, "[redacted]"), raw)
      .slice(0, 500);
    await report({ flow: name, step: "flow", ok: false, screenshot, reason });
  } finally {
    const failures: string[] = [];
    const observedWriters = await writerPids(data).catch(() => {
      failures.push("writer_descriptor_unreadable");
      return [];
    });
    // Shutdown alone uses the existing preload management API when the UI may already be broken.
    const requested = await cdp
      ?.send<{ result?: { value?: boolean } }>(
        "Runtime.evaluate",
        {
          expression: "window.pibot.background.stopService().then(()=>true,()=>false)",
          awaitPromise: true,
          returnByValue: true,
        },
        3000,
      )
      .then((value) => value.result?.value === true)
      .catch(() => false);
    if (requested) {
      const end = Date.now() + 15000;
      while (
        children.some((child) => child.exitCode === null && child.signalCode === null) &&
        Date.now() < end
      )
        await delay(100);
    }
    for (const connection of context?.connections ?? []) connection.close();
    cdp?.close();
    for (const child of children.reverse())
      await stopChild(child).catch(() => failures.push("owned_process_exit_unconfirmed"));
    try {
      const pids = [...new Set([...observedWriters, ...(await writerPids(data))])];
      await confirmWriterExit(pids);
    } catch {
      failures.push("writer_exit_unconfirmed");
    }
    await llm?.stop().catch(() => failures.push("fake_llm_stop_unconfirmed"));
    if (!failures.length) {
      try {
        if (context && ["browser-login", "teach-once"].includes(name)) {
          const files = await noSecrets(data, context.secrets);
          assert(files > 0, "empty_privacy_scan");
          await report({ flow: name, step: "persisted-secret-scan", ok: true });
        }
      } catch {
        passed = false;
        await report({
          flow: name,
          step: "persisted-secret-scan",
          ok: false,
          reason: "plaintext_found_or_scan_incomplete",
        });
      }
      cleanupConfirmed = true;
      if (!keep) {
        await rm(root, { recursive: true, force: true }).catch(() => {
          cleanupConfirmed = false;
          failures.push("temporary_directory_delete_failed");
        });
      }
    }
    if (failures.length) {
      passed = false;
      await report({
        flow: name,
        step: "cleanup",
        ok: false,
        reason: failures.join(","),
        temporaryDirectory: root,
        logs: [join(data, "e2e-owner.log"), join(data, "e2e-gui.log")],
      });
    }
    await report({
      flow: name,
      step: "summary",
      ok: passed && cleanupConfirmed,
      reason:
        cleanupConfirmed && !keep
          ? "temporary_data_deleted"
          : keep && cleanupConfirmed
            ? "temporary_data_kept_by_request"
            : "temporary_data_retained_cleanup_failed",
      ...(keep || !cleanupConfirmed
        ? {
            temporaryDirectory: root,
            logs: [join(data, "e2e-owner.log"), join(data, "e2e-gui.log")],
          }
        : {}),
    });
  }
  return passed && cleanupConfirmed;
}
