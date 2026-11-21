import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const TIMEOUT_MS = 3_000;
const MAX_OUTPUT = 64 * 1024;
const MARK_START = "__PIBOT_PATH_START__";
const MARK_END = "__PIBOT_PATH_END__";

export function readCachedLoginShellPath(dataDir: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  try {
    const raw = readFileSync(join(dataDir, "cache", "terminal-path.json"), "utf8");
    const value = JSON.parse(raw);
    if (!Array.isArray(value?.path) || value.path.length > 256) return [];
    return value.path.filter((entry: unknown): entry is string => {
      if (
        typeof entry !== "string" ||
        entry.length > 4096 ||
        !isAbsolute(entry) ||
        /[\0\r\n]/.test(entry)
      )
        return false;
      try {
        return statSync(entry).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export async function writeCachedLoginShellPath(dataDir: string, path: readonly string[]) {
  const file = join(dataDir, "cache", "terminal-path.json");
  const temp = `${file}.tmp`;
  await mkdir(join(dataDir, "cache"), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify({ path }), { mode: 0o600 });
  await rename(temp, file);
}

/** Read only PATH from the user's login shell; failures deliberately return no override. */
export async function readLoginShellPath(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string[] | undefined> {
  if (platform === "win32") return undefined;
  const shell =
    env.SHELL === "/bin/zsh" || env.SHELL === "/bin/bash"
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lic", `printf '${MARK_START}%s${MARK_END}' "$PATH"`], {
      env: { ...env, PATH: env.PATH ?? "" },
      stdio: ["ignore", "pipe", "ignore"],
      // An interactive zsh often starts helpers (gitstatusd, instant prompt): own process group,
      // so a timeout ends all of them, not only the shell.
      detached: true,
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone: nothing left to stop.
      }
    };
    let output = "";
    const timer = setTimeout(() => {
      killGroup();
      resolve(undefined);
    }, TIMEOUT_MS);
    const finish = (value: string[] | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    const stdout = child.stdout;
    if (!stdout) return finish(undefined);
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) {
        killGroup();
        finish(undefined);
      }
    });
    child.once("error", () => finish(undefined));
    child.once("exit", (code) => {
      if (code !== 0) return finish(undefined);
      const match = new RegExp(`${MARK_START}(.*?)${MARK_END}`, "s").exec(output);
      if (!match) return finish(undefined);
      const candidates = (match[1] ?? "").split(":");
      void Promise.all(
        candidates.map(async (entry) => {
          if (!isAbsolute(entry) || /[\0\r\n]/.test(entry)) return undefined;
          try {
            return (await stat(entry)).isDirectory() ? entry : undefined;
          } catch {
            return undefined;
          }
        }),
      ).then((entries) =>
        finish([...new Set(entries.filter((entry): entry is string => Boolean(entry)))]),
      );
    });
  });
}
