import { ExecError } from "../core/types.ts";
import { readTool } from "./read-tool.ts";
import type { ListeningSocket } from "./types.ts";

/**
 * Windows: `Get-NetTCPConnection -State Listen` (locale independent, unlike netstat's state
 * column), filtered to the given owning PIDs. Read-only; PowerShell is called with argv only.
 */
export async function win32Listeners(
  pids: readonly number[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ListeningSocket[]> {
  const wanted = new Set(pids);
  // commandEnvironment() pins SHELL to the system PowerShell, like the process-tree snapshot.
  const { code, stdout } = await readTool(
    env.SHELL as string,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-NetTCPConnection -State Listen | ForEach-Object { '{0} {1} {2}' -f $_.OwningProcess,$_.LocalPort,$_.LocalAddress }",
    ],
    env,
    4000,
    signal,
  );
  if (code !== 0) throw new ExecError("command_failed", "listener_check_failed");
  const sockets: ListeningSocket[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\S+)$/.exec(line.trim());
    if (!match || !wanted.has(Number(match[1]))) continue;
    sockets.push({ pid: Number(match[1]), port: Number(match[2]), address: match[3] as string });
  }
  return sockets;
}
