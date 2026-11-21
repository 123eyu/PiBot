import type { GitReadOperation, GitWriteOperation } from "@pibot/execution";
import type { MethodParams } from "@pibot/workspaces-contract/full";
import { changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { prepare } from "../write/changes-write.ts";
import { executeWrite } from "../write/changes-write-run.ts";
import { parseStatus } from "./changes-git.ts";
import { notRepoError, probeRepo, read, repoOperation } from "./changes-repo.ts";

export async function listRefs(
  service: ChangesService,
  params: MethodParams["changes.refs"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const probe = await probeRepo(service.reader, scope.root.path, service.platform, signal);
  if (probe.state !== "repo") throw notRepoError(probe);
  const result = await read(() =>
    service.reader.run(
      { op: "refs", kind: params.kind, after: params.after },
      { cwd: scope.root.path, signal, maxBytes: 256 * 1024 },
    ),
  );
  if (result.exitCode !== 0 || result.overflow) throw changesError("changes_ref_unavailable");
  const prefix = params.kind === "branch" ? "refs/heads/" : "refs/tags/";
  const rows = result.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))
    .filter(([ref]) => ref?.startsWith(prefix));
  const refs = rows.slice(0, 50).map(([ref, oid, occupied]) => {
    if (!ref || !oid || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))
      throw changesError("changes_ref_unavailable");
    return { name: ref.slice(prefix.length), oid, occupied: occupied === "1" };
  });
  return {
    refs,
    next: rows.length > 50 ? (rows[49]?.[0] ?? null) : null,
    writable:
      service.platform !== "win32" &&
      probe.info.layoutOk &&
      scope.root.role === "primary" &&
      !scope.nestedReadonly,
  };
}

/** Ref writes deliberately do not expand Windows or managed-worktree admin capabilities. */
export async function writeRef(
  service: ChangesService,
  params: MethodParams["changes.refWrite"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const probe = await probeRepo(service.reader, scope.root.path, service.platform, signal);
  if (probe.state !== "repo") throw notRepoError(probe);
  if (service.platform === "win32" || !probe.info.layoutOk)
    throw changesError("changes_ref_unavailable");
  const prepared = await prepare(service, scope, signal);
  const kind = params.action === "createTag" ? "tag" : "branch";
  const run = (operation: GitReadOperation, bound: AbortSignal) =>
    read(() =>
      service.reader.run(operation, { cwd: scope.root.path, signal: bound, maxBytes: 256 * 1024 }),
    );
  const operation: GitWriteOperation =
    params.action === "switchBranch"
      ? { kind: "switchBranch", name: params.name }
      : {
          kind: "createRef",
          ref: `${kind === "tag" ? "refs/tags/" : "refs/heads/"}${params.name}`,
          oid: params.commit,
        };
  await executeWrite(
    service,
    scope,
    {
      action: "changes.refWrite",
      mode: prepared.mode,
      program: prepared.program,
      operations: [operation],
      files: {},
      facts: { target: params.action },
      verify: async (bound) => {
        // Check after the shared write lease is acquired; the renderer's snapshot grants no authority.
        const fresh = await prepare(service, await service.scope(params, bound), bound);
        if (fresh.info.gitDir !== prepared.info.gitDir || (await repoOperation(fresh.info.gitDir)))
          throw changesError("changes_stale");
        const status = await run({ op: "status", includeSubmodules: true }, bound);
        const head = await run({ op: "head" }, bound);
        const parsed = parseStatus(status.stdout);
        if (
          status.exitCode !== 0 ||
          status.overflow ||
          head.exitCode !== 0 ||
          head.stdout.toString("utf8").trim() !== params.head ||
          parsed.branch !== params.branch
        )
          throw changesError("changes_stale");
        const ref = await run({ op: "ref", kind, name: params.name }, bound);
        if (ref.overflow) throw changesError("changes_stale");
        if (params.action === "switchBranch") {
          if (ref.exitCode !== 0 || ref.stdout.toString("utf8").trim() !== params.commit)
            throw changesError("changes_stale");
          if (parsed.entries.length > 0) throw changesError("changes_ref_dirty");
        } else {
          if (ref.exitCode === 0) throw changesError("changes_ref_exists");
          if (ref.exitCode !== 1 && ref.exitCode !== 128) throw changesError("changes_stale");
          const type = await run({ op: "objectType", oid: params.commit }, bound);
          if (type.exitCode !== 0 || type.stdout.toString("utf8").trim() !== "commit")
            throw changesError("changes_stale");
        }
      },
    },
    signal,
  );
  return { ok: true as const };
}
