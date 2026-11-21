import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { prepareRunnerDataDir } from "./data-dir.ts";
import { runnerInvocation } from "./linux-process.ts";
import { acquireRunnerLock } from "./state.ts";

const MARKER = "# Managed by Pi Bot runner install-service\n";
const UNIT = "pibot-runner.service";

// systemd expands percent specifiers even in quoted arguments; dollar expansion is disabled by colon.
function quote(value: string) {
  if (/[\0\r\n]/.test(value)) throw new Error("invalid_service_argument");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function systemctl(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("systemctl", ["--user", ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    child.once("error", () => reject(new Error("runner_service_unavailable")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("runner_service_failed")),
    );
  });
}

export async function configureLinuxService(options: {
  install: boolean;
  dataDir: string;
  arguments: readonly string[];
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("unsupported_platform");
  const configured = process.env.XDG_CONFIG_HOME;
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
  const directory = join(root, "systemd", "user");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, UNIT);
  const control = join(root, "pibot-runner", "service-control");
  await prepareRunnerDataDir(control);
  const claim = await acquireRunnerLock(control);
  try {
    let existing: string | undefined;
    try {
      const unit = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await unit.stat();
        if (
          !info.isFile() ||
          info.size > 64 * 1024 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())
        )
          throw new Error("runner_service_conflict");
        existing = await unit.readFile("utf8");
      } finally {
        await unit.close();
      }
      if (!existing.startsWith(MARKER)) throw new Error("runner_service_conflict");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!options.install) {
      if (!existing) return;
      await systemctl(["disable", "--now", UNIT], options.signal);
      await unlink(path);
      await systemctl(["daemon-reload"], options.signal);
      return;
    }
    const entry = runnerInvocation();
    const body = [
      MARKER.trimEnd(),
      "[Unit]",
      "Description=Pi Bot Runner",
      "After=network-online.target",
      "[Service]",
      "Type=simple",
      `ExecStart=:${[entry.executable, ...entry.prefix, "runner", "start", "--data-dir", options.dataDir, ...options.arguments].map(quote).join(" ")}`,
      `EnvironmentFile=-${quote(join(root, "pibot-runner", "env"))}`,
      "Restart=on-failure",
      "RestartPreventExitStatus=78",
      "RestartSec=5",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    const temporary = `${path}.${process.pid}.next`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      try {
        await handle.writeFile(body, { signal: options.signal });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
    await systemctl(["daemon-reload"], options.signal);
    // Do not auto-start: a headless user's Secret Service/passphrase may not yet be configured.
    await systemctl(["enable", UNIT], options.signal);
  } finally {
    await claim.release();
  }
}
