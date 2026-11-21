import { open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { GitReadOperation } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { RunsRepo } from "@pibot/storage";
import type { ChangesDiff, ChangesTurn, MethodParams } from "@pibot/workspaces-contract/full";
import { type ChangesScope, changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import {
  parseDiff,
  parseLog,
  parseLogFiles,
  parseNumstat,
  parseStatus,
} from "../git/changes-git.ts";
import { notRepoError, probeRepo, read } from "../git/changes-repo.ts";
import { turnPreviewable, visibleTurn } from "./changes-file.ts";

/** One file's diff text is capped; beyond it only the counts are returned. */
const DIFF_BYTES = 1024 * 1024;
const TURN_FILES = 500;
const TURN_COUNTED = 200;

export async function repo(service: ChangesService, scope: ChangesScope, signal: AbortSignal) {
  const probe = await probeRepo(service.reader, scope.root.path, service.platform, signal);
  if (probe.state !== "repo") throw notRepoError(probe);
  return probe.info;
}

/** Runs one diff; on overflow re-runs the same comparison as --numstat for the counts only. */
async function diffOf(
  service: ChangesService,
  path: string,
  cwd: string,
  operation: Extract<GitReadOperation, { op: "diff" | "diffNoIndex" | "commitDiff" }>,
  signal: AbortSignal,
): Promise<ChangesDiff> {
  const options = { cwd, signal, maxBytes: DIFF_BYTES, timeoutMs: 20_000 };
  const result = await read(() => service.reader.run(operation, options));
  // --no-index exits 1 when the files differ.
  const ok = result.exitCode === 0 || (operation.op === "diffNoIndex" && result.exitCode === 1);
  if (!ok && !result.overflow) throw new Error("git_diff_failed");
  if (result.overflow) {
    const counts = await read(() =>
      service.reader.run({ ...operation, numstat: true }, { ...options, maxBytes: 64 * 1024 }),
    );
    const stats = [...parseNumstat(counts.stdout).values()][0];
    return {
      path,
      binary: stats?.binary ?? false,
      tooLarge: true,
      unavailable: null,
      added: stats?.added ?? null,
      removed: stats?.removed ?? null,
      hunks: [],
    };
  }
  const parsed = parseDiff(result.stdout.toString("utf8"));
  let added = 0;
  let removed = 0;
  for (const hunk of parsed.hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  return {
    path,
    binary: parsed.binary,
    tooLarge: false,
    unavailable: null,
    added: parsed.binary ? null : added,
    removed: parsed.binary ? null : removed,
    hunks: parsed.hunks,
  };
}

/** The path must be in the folder's current status; anything else is stale, never a free read. */
export async function statusEntry(
  service: ChangesService,
  scope: ChangesScope,
  info: Awaited<ReturnType<typeof repo>>,
  path: string,
  signal: AbortSignal,
) {
  const root = scope.root.path;
  let entry = service.remembered(root)?.get(path);
  if (!entry) {
    const status = await read(() =>
      service.reader.run({ op: "status" }, { cwd: root, signal, maxBytes: 32 * 1024 * 1024 }),
    );
    if (status.overflow || status.exitCode !== 0) throw changesError("changes_stale");
    const entries = parseStatus(status.stdout, info.subdirectory).entries;
    service.remember(root, entries);
    entry = entries.find((candidate) => candidate.path === path);
  }
  if (!entry) throw changesError("changes_stale");
  return entry;
}

export async function uncommittedDiff(
  service: ChangesService,
  scope: ChangesScope,
  path: string,
  signal: AbortSignal,
) {
  const info = await repo(service, scope, signal);
  const root = scope.root.path;
  const entry = await statusEntry(service, scope, info, path, signal);
  if (entry.status === "untracked") {
    const absolute = join(root, ...path.split("/"));
    // Never let a symlinked parent turn an untracked path into a read outside the folder.
    if (!containsPath(root, await realpath(dirname(absolute)), service.platform))
      throw changesError("changes_stale");
    return diffOf(service, path, root, { op: "diffNoIndex", left: null, right: absolute }, signal);
  }
  const head = await read(() =>
    service.reader.run({ op: "head" }, { cwd: root, signal, timeoutMs: 5000 }),
  );
  const base = head.exitCode === 0 ? head.stdout.toString("utf8").trim() : info.emptyTree;
  return diffOf(service, path, root, { op: "diff", base, path }, signal);
}

export async function commitDiff(
  service: ChangesService,
  scope: ChangesScope,
  commit: string,
  path: string,
  signal: AbortSignal,
) {
  await repo(service, scope, signal);
  return diffOf(service, path, scope.root.path, { op: "commitDiff", commit, path }, signal);
}

/** The run must belong to this conversation, so a diff request cannot read another Bot's turn. */
export function checkRun(service: ChangesService, scope: ChangesScope, runId: string) {
  const run = new RunsRepo(service.local.deps.db).get(runId);
  if (!run || (scope.groupId ? run.groupId !== scope.groupId : run.botId !== scope.botId))
    throw changesError("changes_stale");
}

export async function turnDiff(
  service: ChangesService,
  scope: ChangesScope,
  runId: string,
  path: string,
  signal: AbortSignal,
): Promise<ChangesDiff> {
  checkRun(service, scope, runId);
  const file = service.turn.repo.summarize(runId).find((candidate) => candidate.path === path);
  if (!file) throw changesError("changes_stale");
  const empty = {
    path,
    binary: false,
    tooLarge: false,
    added: null,
    removed: null,
    hunks: [],
  };
  if (file.kind === "command") return { ...empty, unavailable: "command" };
  if ((file.kind !== "add" && !file.beforeRef) || !file.afterRef)
    return { ...empty, unavailable: "snapshot_missing" };
  const botId = service.turn.repo.botOf(runId) as string;
  const dir = service.turn.snapshotDir(botId, runId);
  return diffOf(
    service,
    path,
    dir,
    {
      op: "diffNoIndex",
      left: file.beforeRef ? join(dir, file.beforeRef) : null,
      right: join(dir, file.afterRef),
    },
    signal,
  );
}

export async function turnFiles(
  service: ChangesService,
  params: MethodParams["changes.turn"],
  signal: AbortSignal,
): Promise<ChangesTurn> {
  let runId: string | undefined;
  if ("runId" in params) runId = params.runId;
  else {
    const scope = await service.scope(params, signal);
    runId = service.turn.repo.latestRun({
      botId: scope.botId,
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    });
  }
  const empty = { runId: null, botId: null, root: null, files: [], total: 0, truncated: false };
  if (!runId) return empty;
  const botId = service.turn.repo.botOf(runId);
  if (!botId) return { ...empty, runId };
  const { checkpoint, recorded, summary } = visibleTurn(service, runId);
  const dir = service.turn.snapshotDir(botId, runId);
  const listed = summary.slice(0, TURN_FILES);
  const counted = await Promise.all(
    listed.map(async (file, index) => {
      const available =
        file.kind !== "command" && !!file.afterRef && (file.kind === "add" || !!file.beforeRef);
      let stats = { added: null as number | null, removed: null as number | null, binary: false };
      if (available && index < TURN_COUNTED) {
        const result = await service
          .cached(`${file.beforeRef}:${file.afterRef}`, () =>
            read(() =>
              service.reader.run(
                {
                  op: "diffNoIndex",
                  left: file.beforeRef ? join(dir, file.beforeRef) : null,
                  right: join(dir, file.afterRef as string),
                  numstat: true,
                },
                { cwd: dir, signal, maxBytes: 64 * 1024, timeoutMs: 10_000 },
              ),
            ).then((r) => [...parseNumstat(r.stdout).values()][0]),
          )
          .catch(() => undefined);
        if (result) stats = result;
        // Windows acceptance 2026-11-20: without git the numstat fails and every row showed a
        // "…" that never resolved. A new file's count needs no diff: its lines are all added.
        else if (file.kind === "add" && !file.beforeRef && file.afterRef)
          stats = (await addedLines(join(dir, file.afterRef), signal)) ?? stats;
      }
      const display = containsPath(file.root, file.path, service.platform)
        ? relative(file.root, file.path).split(/[\\/]/).join("/") || file.path
        : file.path;
      return {
        path: file.path,
        displayPath: display,
        kind: file.kind,
        ...stats,
        diffAvailable: available,
        previewable: turnPreviewable(file, service.platform),
      };
    }),
  );
  return {
    runId,
    botId,
    root: recorded[0]?.root ?? null,
    files: counted,
    total: summary.length,
    restoredCount: recorded.length - summary.length,
    truncated: summary.length > listed.length,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

export async function changesLog(
  service: ChangesService,
  params: MethodParams["changes.log"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const info = await repo(service, scope, signal);
  const cwd = scope.root.path;
  let from = params.before;
  if (!from) {
    const head = await read(() =>
      service.reader.run({ op: "head" }, { cwd, signal, timeoutMs: 5000 }),
    );
    if (head.exitCode !== 0) return { commits: [], hasMore: false };
    from = head.stdout.toString("utf8").trim();
  }
  const limit = params.limit ?? 50;
  const operation = {
    op: "log" as const,
    from: from as string,
    skip: params.before ? 1 : 0,
    limit: limit + 1,
    // Only commits that touched this folder.
    scoped: !!info.subdirectory,
  };
  // Names only (no content diff) give each commit's file count cheaply; a page whose
  // name lists overflow (e.g. a vendored-dependency commit) falls back to the plain log.
  const counted = await read(() =>
    service.reader.run(
      { ...operation, files: true },
      { cwd, signal, maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000 },
    ),
  );
  if (counted.exitCode === 0 && !counted.overflow) {
    const commits = parseLogFiles(counted.stdout);
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
  }
  const result = await read(() =>
    service.reader.run(operation, { cwd, signal, maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  );
  if (result.exitCode !== 0) throw changesError("changes_stale");
  const commits = parseLog(result.stdout);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

/** Lines of a new snapshot file, read only when small; binary when it holds a NUL byte. */
async function addedLines(path: string, signal: AbortSignal) {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const size = (await handle.stat()).size;
    if (size > 2 * 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, 0);
    signal.throwIfAborted();
    if (bytes.includes(0)) return { added: null, removed: null, binary: true };
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    if (size && bytes[size - 1] !== 10) lines++;
    return { added: lines, removed: 0, binary: false };
  } finally {
    await handle.close();
  }
}
