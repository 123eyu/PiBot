import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const UNKNOWN_ACTIVITY = "unknown:owner_activity_unavailable";
const quoteRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type ProcessRun = (
  command: string,
  args: string[],
) => {
  status: number | null;
  stdout: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};
const metadataRun: ProcessRun = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 5000 });

/** Numeric process metadata only; no full process arguments, logs, chats or database rows. */
export function bundleProcesses(bundle: string, run: ProcessRun = metadataRun): number[] {
  const result = run("/usr/bin/pgrep", ["-f", `${quoteRegex(bundle)}/Contents/`]);
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1))
    throw new Error("owner_process_state_unknown");
  if (result.status === 1) return [];
  const rows = result.stdout.trim().split(/\s+/);
  if (!rows.length || rows.some((row) => !/^[1-9]\d*$/.test(row)))
    throw new Error("owner_process_state_unknown");
  const pids: number[] = [];
  for (const row of rows) {
    const executable = run("/bin/ps", ["-p", row, "-o", "comm="]);
    if (executable.status === 1 && !executable.error && !executable.signal) continue;
    if (executable.status !== 0 || executable.error || executable.signal)
      throw new Error("owner_process_state_unknown");
    // pgrep also matches command arguments. Only an executable physically named under this
    // exact bundle is ours; a dev command mentioning the path is never a shutdown target.
    if (executable.stdout.trim().startsWith(`${bundle}/Contents/`)) pids.push(Number(row));
  }
  return pids;
}

/** Metadata absence is distinct from a permission or filesystem failure. */
export function ownerDescriptorPresent(
  path: string,
  inspect: (path: string) => unknown = lstatSync,
) {
  try {
    inspect(path);
    return true;
  } catch (error) {
    // existsSync also returns false on EACCES. Only explicit absence can attest no owner.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("owner_metadata_state_unknown");
  }
}

/** No live activity/maintenance lane exists yet. A live owner is unknown, never inferred idle. */
export function ownerActivity(
  bundle: string,
  data: string,
  observe = {
    processes: bundleProcesses,
    descriptorExists: ownerDescriptorPresent,
  },
): string[] {
  try {
    if (
      observe.processes(bundle).length ||
      observe.descriptorExists(join(data, "background-runtime", "owner.json"))
    )
      return [UNKNOWN_ACTIVITY];
    return [];
  } catch {
    return [UNKNOWN_ACTIVITY];
  }
}
