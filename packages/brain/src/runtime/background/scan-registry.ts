import { posix, win32 } from "node:path";
import type { Platform } from "@pibot/policy";
import { containsPath } from "@pibot/policy";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";

export function scanScope(
  context: ToolRunContext,
  source: { groupId?: string; conversationId?: string },
  prepared: PreparedTool,
) {
  return JSON.stringify([
    context.botId,
    source.groupId,
    source.conversationId,
    context.conversationId,
    prepared.boundary?.location?.target ?? "local",
    prepared.settings,
    prepared.boundary,
    prepared.authorization,
  ]);
}

/** Only parsed du scans, optionally storing stdout; opaque shells remain independent. */
export function scanPaths(prepared: PreparedTool, platform: Platform): string[] | undefined {
  const analysis = prepared.result?.analysis;
  // Policy may mark an approved read outside the workplace as non-readonly; the parsed
  // invocation and absence of writes/network, rather than that permission flag, identify du.
  if (
    !analysis ||
    analysis.incomplete ||
    (analysis.writes.length > 0 &&
      (!analysis.literalOutputRedirect ||
        analysis.writes.length !== 1 ||
        analysis.commands.length !== 1)) ||
    analysis.network ||
    prepared.docker ||
    prepared.secretUses?.length
  )
    return;
  const commands = analysis.commands;
  if (
    analysis.writes.length &&
    !["du", "/usr/bin/du", "/bin/du"].includes(
      analysis.literalOutputRedirect?.command.program ?? "",
    )
  )
    return;
  const scans = commands.filter((item) => ["du", "/usr/bin/du", "/bin/du"].includes(item.program));
  if (
    scans.length !== 1 ||
    commands.some(
      (item) => !["du", "/usr/bin/du", "/bin/du", "sort", "head", "tail"].includes(item.program),
    )
  )
    return;
  const operands: string[] = [];
  const args = scans[0]?.args ?? [];
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--" && !literal) {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      if (
        /^-(?:[achkmPsSx]+|[achkmPsSx]*d\d+)$/.test(arg) ||
        ["--all", "--summarize", "--human-readable"].includes(arg)
      )
        continue;
      if (arg === "-d" || arg === "--max-depth") {
        if (!/^\d+$/.test(args[++index] ?? "")) return;
        continue;
      }
      if (/^--max-depth=\d+$/.test(arg)) continue;
      return;
    }
    if (!arg || /[\0\r\n~]/.test(arg)) return;
    operands.push(arg);
  }
  if (operands.length > 16) return;
  const api = platform === "win32" ? win32 : posix;
  return (operands.length ? operands : ["."]).map((path) => api.resolve(prepared.cwd, path));
}

export function scanOutputPath(prepared: PreparedTool, platform: Platform): string | undefined {
  const output = prepared.result?.analysis?.literalOutputRedirect?.path;
  if (!output || !scanPaths(prepared, platform)) return;
  return (platform === "win32" ? win32 : posix).resolve(prepared.cwd, output);
}

interface Reservation<T> {
  scope: string;
  roots: readonly string[];
  ready: Promise<T>;
}

/** Admission occupies the roots before any spawn await; only the owner releases its entry. */
export class ScanRegistry<T> {
  private readonly entries = new Set<Reservation<T>>();
  track(scope: string, roots: readonly string[], value: T) {
    const entry = { scope, roots, ready: Promise.resolve(value) };
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }
  acquire(scope: string, roots: readonly string[], platform: Platform) {
    const previous = [...this.entries].find(
      (entry) =>
        entry.scope === scope &&
        entry.roots.some((a) =>
          roots.some((b) => containsPath(a, b, platform) || containsPath(b, a, platform)),
        ),
    );
    if (previous) return { previous: previous.ready };
    let accept!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<T>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // The initiating tool receives start failures too; a reservation need not have a waiter.
    void ready.catch(() => {});
    const entry = { scope, roots, ready };
    this.entries.add(entry);
    return { owner: { accept, reject, release: () => this.entries.delete(entry) } };
  }
}
