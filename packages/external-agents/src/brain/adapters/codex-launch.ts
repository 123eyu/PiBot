// How Codex runs inside Pi Bot's sandbox. Codex's own sandbox cannot nest
// in Pi Bot's, so its default modes fail every command; its full-access mode never asks.
// A permission profile with full file access and network (Pi Bot's sandbox does the isolating)
// keeps `approval_policy = on-request`, so whatever Codex still asks reaches Pi Bot's card.
// Codex 0.167 removed `untrusted` (ask before every command) and refuses
// `extends = ":danger-full-access"`; there is no setting left that makes it ask before each
// command without its own sandbox.
//
// The adapter's per-session CODEX_CONFIG does not reach the profile list, so the profile is given
// as `-c` overrides on the command line by a tiny launcher the adapter starts instead of `codex`.
// It lives in Pi Bot's data (readable to the agent, never writable) and never touches the user's
// own config.toml.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_PROFILE = "pibot-outer";
/** The adapter names each permission profile mode `permission-profile:<id>`. */
export const CODEX_PROFILE_MODE = `permission-profile:${CODEX_PROFILE}`;

/** Parsed by Codex as TOML, falling back to the raw string; none needs shell quoting inside ''. */
const OVERRIDES = [
  `permissions.${CODEX_PROFILE}.description=Pi Bot outer sandbox: Pi Bot isolates the whole Codex process`,
  `permissions.${CODEX_PROFILE}.filesystem={":root"="write"}`,
  `permissions.${CODEX_PROFILE}.network={enabled=true}`,
  `default_permissions=${CODEX_PROFILE}`,
  "approval_policy=on-request",
];

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The launcher for this Codex program (POSIX only; Windows runs Codex unisolated with its own
 * sandbox and approvals). Content-addressed, so a changed program path gets a new folder.
 */
export async function codexLauncher(dataDir: string, program: string) {
  const script = [
    "#!/bin/sh",
    // Commands Codex runs get their environment from its shell_environment_policy, and a user's
    // own config can set a proxy there (Mac acceptance: HTTP(S)_PROXY=127.0.0.1:7890, unreachable
    // inside the sandbox). They get the sandbox's own proxy instead, read here at start; the
    // names are fixed and each value is passed as one argument (printenv), never evaluated.
    "for name in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy; do",
    '  value=$(printenv "$name")',
    '  [ -n "$value" ] && set -- -c "shell_environment_policy.set.$name=$value" "$@"',
    "done",
    `exec ${[program, ...OVERRIDES.flatMap((value) => ["-c", value])].map(quote).join(" ")} "$@"`,
    "",
  ].join("\n");
  const hash = createHash("sha256").update(script).digest("hex").slice(0, 16);
  const folder = join(dataDir, "runtimes", "codex-launch", hash);
  const path = join(folder, "codex");
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current !== script) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, script, { mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, path);
  }
  return { path, folder };
}
