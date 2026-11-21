import { ExecError } from "../core/types.ts";
import { readTool } from "./read-tool.ts";
import type { ListeningSocket } from "./types.ts";

/**
 * macOS: `lsof` restricted to the given PIDs and TCP sockets in LISTEN state, machine-readable
 * fields only (`p` pid, `n` local address). Read-only and needs no extra privilege for our own
 * child processes.
 */
export async function darwinListeners(
  pids: readonly number[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ListeningSocket[]> {
  const { code, stdout, stderrPresent } = await readTool(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-F", "pn"],
    env,
    2000,
    signal,
  );
  // Exit 1 with empty stderr means no match; partial output after an error is not authoritative.
  if ((code !== 0 && code !== 1) || stderrPresent)
    throw new ExecError("command_failed", "listener_check_failed");
  const sockets: ListeningSocket[] = [];
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const match = /^n(.*):(\d+)$/.exec(line);
      if (!match) continue;
      const host = (match[1] as string).replace(/^\[|\]$/g, "");
      // lsof prints "*" for both 0.0.0.0 and ::, i.e. every interface.
      sockets.push({ pid, address: host === "*" ? "0.0.0.0" : host, port: Number(match[2]) });
    }
  }
  return sockets;
}
