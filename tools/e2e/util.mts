import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function until<T>(
  name: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  signal: AbortSignal,
  ms = 45000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    signal.throwIfAborted();
    const value = await read();
    if (ready(value)) return value;
    await delay(150, undefined, { signal });
  }
  throw new Error(`e2e_timeout:${name}`);
}
export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SystemRoot",
      "WINDIR",
      "LANG",
      "DISPLAY",
      // An X server with access control (xvfb-run, most desktops) also needs its cookie file.
      "XAUTHORITY",
      "WAYLAND_DISPLAY",
      // Chromium picks its Linux password store (libsecret vs. insecure basic) from the desktop.
      "XDG_CURRENT_DESKTOP",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}
export function launch(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  logFile: string,
) {
  // Keep stdout/stderr inside disposable data so the same secret scan covers console leaks.
  const descriptor = openSync(logFile, "ax", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      env,
      cwd,
      stdio: ["ignore", descriptor, descriptor],
      detached: process.platform !== "win32",
    });
  } finally {
    closeSync(descriptor);
  }
  // Retain errors instead of allowing an unhandled event before the CDP startup deadline.
  let error: Error | undefined;
  child.on("error", (e) => {
    error = e;
  });
  return {
    child,
    assertStarted() {
      if (error || child.exitCode !== null) throw new Error("e2e_app_start_failed");
    },
  };
}
export async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; i < 60 && !exited(); i++) await delay(100);
  if (!exited()) {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
    for (let i = 0; i < 30 && !exited(); i++) await delay(100);
  }
  assert(exited(), "e2e_process_exit_unconfirmed");
}
export async function confirmWriterExit(pids: number[], timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let alive = false;
    for (const pid of pids) {
      assert(Number.isSafeInteger(pid) && pid > 0, "invalid_writer_pid");
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (!alive) return;
    if (Date.now() >= end) throw new Error("e2e_writer_exit_unconfirmed");
    await delay(100);
  }
}
export async function noSecrets(root: string, secrets: string[]) {
  let count = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(++count <= 20000, "e2e_scan_limit");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("e2e_scan_link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        assert((await stat(path)).size <= 64 * 1024 * 1024, "e2e_scan_file_limit");
        const bytes = await readFile(path);
        for (const secret of secrets) {
          const variants = [
            Buffer.from(secret),
            Buffer.from(secret, "utf16le"),
            Buffer.from(encodeURIComponent(secret)),
          ];
          assert(
            !variants.some((value) => bytes.includes(value)),
            "e2e_plaintext_secret_in_persisted_data",
          );
        }
      }
    }
  };
  await walk(root);
  return count;
}
