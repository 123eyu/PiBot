import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ExecError } from "../core/types.ts";
import { killGit } from "./git-process.ts";
import { gitPrograms } from "./git-program.ts";

export interface GitConfigurationProcessOptions {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  resourcesDir?: string;
}
export async function configurationGitProgram(
  requested: string,
  options: GitConfigurationProcessOptions,
) {
  const candidates = gitPrograms(options.platform, options.env, options.resourcesDir).filter(
    (path) => requested === "git" || path === requested,
  );
  for (const path of candidates) {
    try {
      await access(path, options.platform === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["ENOENT", "EACCES"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  return undefined;
}

/** Fixed Git config operations only, against a disposable file, with no ambient configuration. */
export async function runConfigurationGit(
  program: string,
  args: string[],
  directory: string,
  options: GitConfigurationProcessOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  return runPrivateGit(
    program,
    ["--no-pager", "config", "--no-includes", ...args],
    directory,
    options,
    signal,
  );
}

/** The other fixed operation shares cleanup/env; it never receives arbitrary command options. */
export async function runConfigurationObjectType(
  program: string,
  oid: string,
  objectDirectory: string,
  directory: string,
  options: GitConfigurationProcessOptions,
  signal: AbortSignal,
) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid) || !isAbsolute(objectDirectory))
    throw new ExecError("invalid_input");
  const result = await runPrivateGit(
    program,
    [
      "--no-pager",
      "--no-replace-objects",
      "--no-lazy-fetch",
      `--git-dir=${directory}`,
      "-c",
      "protocol.allow=never",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "cat-file",
      "-t",
      oid,
    ],
    directory,
    options,
    signal,
    objectDirectory,
  );
  if (result.toString("ascii") !== "commit\n") throw new ExecError("invalid_input");
}

async function runPrivateGit(
  program: string,
  args: string[],
  directory: string,
  options: GitConfigurationProcessOptions,
  signal: AbortSignal,
  objectDirectory?: string,
): Promise<Buffer> {
  signal.throwIfAborted();
  const suppliedRoot = Object.entries(options.env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  const systemRoot =
    suppliedRoot && isAbsolute(suppliedRoot) && !/[\0\r\n]/.test(suppliedRoot)
      ? suppliedRoot
      : undefined;
  const nullFile = options.platform === "win32" ? "NUL" : "/dev/null";
  const child = spawn(program, args, {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    detached: options.platform !== "win32",
    env: {
      PATH: [
        dirname(program),
        ...(options.platform === "win32" && systemRoot
          ? [join(systemRoot, "System32")]
          : ["/usr/bin", "/bin"]),
      ].join(delimiter),
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: directory,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      GIT_CONFIG_SYSTEM: nullFile,
      GIT_CONFIG_GLOBAL: nullFile,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      LC_ALL: "C",
      LANG: "C",
      ...(objectDirectory
        ? {
            GIT_OBJECT_DIRECTORY: objectDirectory,
            GIT_NO_LAZY_FETCH: "1",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_ALLOW_PROTOCOL: "",
          }
        : {}),
      ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    },
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const kill = () => killGit(options, child);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 262_144) {
      failed = true;
      kill();
    } else chunks.push(chunk);
  });
  // Raw diagnostics can contain copied configuration or requested values; never return them.
  child.stderr.resume();
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new ExecError("command_failed")));
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    if (failed || code !== 0) throw new ExecError("command_failed");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
  }
}
