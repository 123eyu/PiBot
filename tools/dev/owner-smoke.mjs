// Main-process boot check: start the built background owner (out/main) with a throwaway data
// directory and wait for a utility -> host RPC round trip and owner readiness. Renderer smoke and acceptance
// never start the main process, so a bundle that crashes there (2026-10-21: an external
// @pibot/* import loaded as TypeScript source) would otherwise show up only in a packaged app.
// Usage: node tools/dev/owner-smoke.mjs <apps/desktop>
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const app = resolve(process.argv[2] ?? "apps/desktop");
const electron = createRequire(join(app, "package.json"))("electron");
// The owner's socket lives under its data directory and Unix socket paths are short (~104 bytes);
// a long TMPDIR (sandboxes, CI) would fail for that reason alone, so POSIX uses /tmp.
const data = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pb-owner-"));
let log = "";
let failure = "owner_startup_timeout";
let cancelled = false;
const cancel = () => { cancelled = true; failure = "owner_cancelled"; };
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const child = spawn(electron, [app, "--no-first-run", "--pibot-background"], {
  env: { ...process.env, PIBOT_DATA_DIR: data, ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let exited = false;
let exitReason = "";
const exit = new Promise((done) => {
  child.once("exit", (code, signal) => {
    exited = true;
    exitReason = `code=${code ?? "none"} signal=${signal ?? "none"}`;
    done();
  });
  child.once("error", () => {
    exited = true;
    failure = "owner_spawn_failed";
    done();
  });
});
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
async function entries(directory) {
  const root = join(data, directory);
  const files = (await readdir(root).catch(() => [])).filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name));
  const lines = await Promise.all(files.map((name) => readFile(join(root, name), "utf8")));
  return lines.join("\n").split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // A trailing partial log record is retried on the next poll.
    }
  });
}
const startupEvent = (rows, event) => rows.some((row) => {
  try {
    const value = JSON.parse(row.message);
    return value.module === "startup" && value.event === event;
  } catch {
    return false;
  }
});
async function waitExit(milliseconds) {
  const waiting = new AbortController();
  try {
    await Promise.race([exit, delay(milliseconds, undefined, { signal: waiting.signal })]);
  } finally {
    waiting.abort();
  }
}
let ok = false;
try {
  let stableAt;
  const deadline = Date.now() + 45_000;
  while (!exited && !cancelled && Date.now() < deadline) {
    const [host, brain] = await Promise.all([entries("host-logs"), entries("logs")]);
    if (startupEvent(brain, "host_rpc_failed")) {
      failure = "host_rpc_failed";
      break;
    }
    if (host.some((row) => /brain exited|brain restart limit/.test(row.message)) ||
        brain.some((row) => row.message === "brain startup failed")) {
      failure = "brain_startup_failed";
      break;
    }
    // host_rpc_ready is emitted by the utility only after a schema-validated response;
    // a live PID or a main-side request receipt alone cannot satisfy this check.
    if (startupEvent(brain, "host_rpc_ready") && startupEvent(host, "owner_ready")) {
      stableAt ??= Date.now();
      if (Date.now() - stableAt >= 8000) {
        ok = true;
        break;
      }
    } else failure = startupEvent(brain, "host_rpc_ready") ? "owner_ready_timeout" : "host_rpc_timeout";
    await delay(250);
  }
  if (exited && failure !== "owner_spawn_failed") failure = "owner_exited";
} finally {
  if (!exited) child.kill("SIGTERM");
  await waitExit(10_000);
  if (!exited) {
    child.kill("SIGKILL");
    await waitExit(5000);
  }
  if (exited) await rm(data, { recursive: true, force: true });
  else {
    ok = false;
    failure = "owner_exit_unconfirmed";
  }
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
if (!ok) {
  console.error(log.split("\n").filter((line) => /error|threw|Error/i.test(line)).slice(-10).join("\n"));
  console.log(`owner smoke: FAILED (${failure}${exitReason ? `; ${exitReason}` : ""})`);
  process.exit(1);
}
console.log("owner smoke: ok");
