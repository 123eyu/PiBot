import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeFile, ChangesStatus, MethodParams } from "@pibot/workspaces-contract/full";
import { type ChangesScope, writeMode } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import {
  compare,
  isGenerated,
  type LineStats,
  parseCommitFiles,
  parseNumstat,
  parseStatus,
  type StatusEntry,
} from "./changes-git.ts";
import { countLines, probeRepo, read, readIdentity, repoOperation } from "./changes-repo.ts";

const STATUS_BYTES = 32 * 1024 * 1024;
/** How long status waits for line counts before answering with statsPending (measured 0.8–1.8 s). */
export const STATS_WAIT_MS = 250;
const UNTRACKED_COUNTED = 2000;

function page<T extends { path: string }>(items: T[], cursor?: string, limit = 500) {
  let start = 0;
  if (cursor !== undefined) {
    // Items are sorted by path; binary search keeps paging O(log n) on 1000+ files.
    let high = items.length;
    while (start < high) {
      const middle = (start + high) >>> 1;
      if (compare((items[middle] as T).path, cursor) <= 0) start = middle + 1;
      else high = middle;
    }
  }
  const slice = items.slice(start, start + limit);
  return {
    slice,
    nextCursor: start + limit < items.length ? (slice.at(-1)?.path ?? null) : null,
  };
}
function totals(files: (LineStats & { path: string })[]) {
  return files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      added: sum.added + (file.added ?? 0),
      removed: sum.removed + (file.removed ?? 0),
    }),
    { files: 0, added: 0, removed: 0 },
  );
}

/** Status output plus each changed file's size/mtime: content edits that keep "M" still refresh. */
async function statsKey(root: string, head: string | null, raw: Buffer, entries: StatusEntry[]) {
  const hash = createHash("sha256")
    .update(head ?? "")
    .update(raw);
  const listed = entries.slice(0, 5000);
  for (let index = 0; index < listed.length; index += 128) {
    const batch = listed.slice(index, index + 128);
    const infos = await Promise.all(
      batch.map((entry) => lstat(join(root, ...entry.path.split("/"))).catch(() => undefined)),
    );
    for (const [offset, entry] of batch.entries()) {
      const info = infos[offset];
      hash.update(`${entry.path}\0${info?.size ?? -1}\0${info?.mtimeMs ?? -1}\0`);
    }
  }
  return hash.digest("hex");
}

export async function changesStatus(
  service: ChangesService,
  params: MethodParams["changes.status"],
  signal: AbortSignal,
): Promise<ChangesStatus> {
  const scope = await service.scope(params, signal);
  const { reader, platform } = service;
  const root = scope.root;
  const base = {
    root: {
      id: root.id,
      name: root.name,
      path: root.path,
      role: root.role,
      ...(root.kind ? { kind: root.kind } : {}),
    },
    roots: [...scope.roots, ...(scope.views ?? [])].map(({ id, name, path, role, kind }) => ({
      id,
      name,
      path,
      role,
      ...(kind ? { kind } : {}),
    })),
  };
  // Probe, status and identity are independent reads; in a non-repo the extra two just fail.
  const listing = read(() =>
    params.commit
      ? reader.run(
          { op: "commitFiles", commit: params.commit },
          { cwd: root.path, signal, maxBytes: STATUS_BYTES, timeoutMs: 30_000 },
        )
      : reader.run(
          { op: "status" },
          { cwd: root.path, signal, maxBytes: STATUS_BYTES, timeoutMs: 30_000 },
        ),
  );
  const identity = readIdentity(reader, root.path, signal);
  const isolationStatus = service.local.target.isolationStatus(signal);
  // Ahead / behind against the upstream this computer already knows; never fetches.
  const upstreamRead = params.commit
    ? Promise.resolve(null)
    : reader
        .run({ op: "upstream" }, { cwd: root.path, signal, timeoutMs: 5000, maxBytes: 1024 })
        .then(parseUpstream, () => null);
  const settled = Promise.allSettled([listing, identity, isolationStatus, upstreamRead]);
  const probe = await probeRepo(reader, root.path, platform, signal).catch(async (error) => {
    await settled;
    throw error;
  });
  if (probe.state === "none") {
    await settled;
    return {
      ...base,
      git: probe,
      author: null,
      files: [],
      total: 0,
      nextCursor: null,
      overflow: false,
      totals: null,
      statsPending: false,
    };
  }
  await settled;
  const [raw, author, operation, isolation, upstream] = await Promise.all([
    listing,
    identity,
    repoOperation(probe.info.gitDir),
    isolationStatus,
    upstreamRead,
  ]);
  if (raw.exitCode !== 0 && !raw.overflow) throw new Error("git_status_failed");
  const { subdirectory } = probe.info;
  const status = params.commit ? undefined : parseStatus(raw.stdout, subdirectory);
  const head =
    status?.head ??
    (await read(() => reader.run({ op: "head" }, { cwd: root.path, signal, timeoutMs: 5000 })).then(
      (r) => (r.exitCode === 0 ? r.stdout.toString("utf8").trim() || null : null),
    ));
  const mode = writeMode(platform, isolation);
  const managedLayout =
    !probe.info.layoutOk && (await service.managedLayout?.allows(scope, signal));
  const readOnlyReason =
    root.role === "readonly"
      ? ("readonly_root" as const)
      : subdirectory
        ? ("repo_above_folder" as const)
        : (!probe.info.layoutOk && !managedLayout) || scope.nestedReadonly
          ? ("repo_layout" as const)
          : operation
            ? ("operation_in_progress" as const)
            : !mode
              ? ("isolation_unavailable" as const)
              : null;
  const git = {
    state: "repo" as const,
    branch: status ? status.branch : null,
    head: head && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? head : null,
    operation,
    writable: readOnlyReason === null,
    readOnlyReason,
    subdirectory,
    hooksSkipped: true as const,
    writesIsolated: mode !== "direct",
    upstream: status?.branch ? upstream : null,
  };
  const common = { ...base, git, author, overflow: raw.overflow };
  if (raw.overflow)
    return { ...common, files: [], total: 0, nextCursor: null, totals: null, statsPending: false };
  if (params.commit) {
    const files = [...parseCommitFiles(raw.stdout)]
      .map(([path, file]) => ({ path, ...file, generated: isGenerated(path) }))
      .sort((a, b) => compare(a.path, b.path));
    const { slice, nextCursor } = page(files, params.cursor, params.limit);
    return {
      ...common,
      files: slice,
      total: files.length,
      nextCursor,
      totals: totals(files),
      statsPending: false,
    };
  }
  const entries = status?.entries ?? [];
  service.remember(root.path, entries);
  const key = await statsKey(root.path, git.head, raw.stdout, entries);
  const stats = await service.stats(scope, key, (job) =>
    lineStats(service, scope, git.head ?? probe.info.emptyTree, entries, job),
  );
  const ready = stats ?? undefined;
  const files: ChangeFile[] = entries.map((entry) => {
    const line = ready?.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      added: line?.added ?? null,
      removed: line?.removed ?? null,
      binary: line?.binary ?? false,
      generated: isGenerated(entry.path),
    };
  });
  const { slice, nextCursor } = page(files, params.cursor, params.limit);
  return {
    ...common,
    files: slice,
    total: files.length,
    nextCursor,
    totals: ready ? totals(files) : null,
    statsPending: !ready,
  };
}

/** Runs under the service signal, not the request's, so a slow numstat still fills the cache. */
async function lineStats(
  service: ChangesService,
  scope: ChangesScope,
  base: string,
  entries: StatusEntry[],
  signal: AbortSignal,
) {
  const root = scope.root.path;
  const result = await read(() =>
    service.reader.run(
      { op: "numstat", base },
      { cwd: root, signal, maxBytes: STATUS_BYTES, timeoutMs: 60_000 },
    ),
  );
  const stats = result.exitCode === 0 ? parseNumstat(result.stdout) : new Map<string, LineStats>();
  const untracked = entries.filter((entry) => entry.status === "untracked");
  for (let index = 0; index < Math.min(untracked.length, UNTRACKED_COUNTED); index += 16) {
    signal.throwIfAborted();
    const batch = untracked.slice(index, Math.min(index + 16, UNTRACKED_COUNTED));
    const counts = await Promise.all(
      batch.map((entry) => countLines(root, entry.path, service.platform)),
    );
    for (const [offset, entry] of batch.entries())
      stats.set(entry.path, counts[offset] as LineStats);
  }
  return stats;
}

/** The upstream read prints "ahead<TAB>behind"; a branch without an upstream exits 128. */
function parseUpstream(result: { exitCode: number | null; stdout: Buffer }) {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(result.stdout.toString("utf8"));
  if (result.exitCode !== 0 || !match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}
