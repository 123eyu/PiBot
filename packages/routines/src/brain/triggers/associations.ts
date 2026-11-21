import { randomUUID } from "node:crypto";
import type { LocalService } from "@pibot/brain/kit";
import { routineSelectionFor, workspaceBoundary } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";
import {
  type RoutineDraft,
  RpcError,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol";
import { ManagedWorktreesRepo } from "@pibot/storage";
import { routinePreauthKey } from "../../store/index.ts";

export async function prepareAssociations(
  local: LocalService,
  draft: Pick<RoutineDraft, "botId" | "triggers" | "preauth"> & {
    workplace?: RoutineDraft["workplace"];
  },
  signal: AbortSignal,
  retained: ReadonlySet<string> = new Set(),
) {
  // The routine's own folders, not the Bot's: watched folders join as read-only roots.
  const existing = await local.workplaces.context(
    draft.botId,
    signal,
    routineSelectionFor(local, draft),
  );
  const paths = new Set(existing.boundary.readRoots);
  const additions = draft.triggers.flatMap((t) => {
    if (t.kind !== "folder" || paths.has(t.path)) return [];
    paths.add(t.path);
    return [{ id: randomUUID(), path: t.path, role: "readonly" as const }];
  });
  const boundary = await workspaceBoundary(
    [...existing.boundary.roots, ...additions],
    existing.boundary.revision,
    local.deps.platform,
    signal,
    new ManagedWorktreesRepo(local.deps.db).byPath(existing.boundary.primaryPath),
  );
  for (const op of draft.preauth)
    if (
      !retained.has(routinePreauthKey(op)) &&
      (op.category === "write_file" || op.category === "run_command") &&
      op.scope.kind !== "folder" &&
      op.scope.kind !== "domain" &&
      (!boundary.writeRoots.some((r) =>
        containsPath(
          r,
          op.scope.kind === "programs" || op.scope.kind === "workplace" ? op.scope.root : "",
          local.deps.platform,
        ),
      ) ||
        boundary.denyWriteRoots.some((r) =>
          containsPath(
            r,
            op.scope.kind === "programs" || op.scope.kind === "workplace" ? op.scope.root : "",
            local.deps.platform,
          ),
        ))
    )
      throw new RpcError(-32602, "Monitor association invalidates write consent");
  return boundary;
}
// Metadata is captured before BEGIN; new store IDs/revision are bound synchronously inside it.
export function commitAssociations(
  local: LocalService,
  draft: RoutineDraft,
  captured: WorkspaceSnapshot,
  retained: ReadonlySet<string> = new Set(),
) {
  for (const t of draft.triggers)
    if (t.kind === "folder") local.workplaces.repo.addReadOnly(draft.botId, t.path);
  const { selection } = routineSelectionFor(local, draft);
  const ids = [...(selection.primary === "home" ? [] : [selection.primary]), ...selection.readonly];
  const rows = local.workplaces.repo.folders(draft.botId, ids);
  const metadata = new Map(captured.roots.map((r) => [r.path, r]));
  const inputs = [
    ...(selection.primary === "home"
      ? [{ id: "home", path: local.workplaces.repo.home(draft.botId) }]
      : []),
    ...ids.map((id) => {
      const row = rows.get(id);
      if (!row) throw new RpcError(-32602, "Workspace changed before confirmation");
      return { id, path: row.path };
    }),
  ];
  const roots = inputs.map((input) => {
    // The captured home is canonical; the registry path of home is not.
    const saved =
      metadata.get(input.path) ??
      (input.id === "home" ? captured.roots.find((r) => r.id === "home") : undefined);
    if (!saved) throw new RpcError(-32602, "Workspace changed before confirmation");
    return {
      ...saved,
      ...input,
      ...(input.id === "home" ? { path: saved.path } : {}),
      role: input.id === selection.primary ? ("primary" as const) : ("readonly" as const),
    };
  });
  const primary = roots.find((r) => r.role === "primary");
  if (!primary) throw new RpcError(-32602, "Workspace primary missing");
  const readonlySource = captured.readonlySource;
  const denied = roots
    .filter((r) => r.role === "readonly" && r.canonicalPath !== readonlySource)
    .map((r) => r.canonicalPath);
  const conflict = denied.some((r) => containsPath(r, primary.canonicalPath, local.deps.platform));
  for (const op of draft.preauth)
    if (
      !retained.has(routinePreauthKey(op)) &&
      (op.category === "write_file" || op.category === "run_command") &&
      (conflict ||
        !("root" in op.scope) ||
        !containsPath(primary.canonicalPath, op.scope.root, local.deps.platform) ||
        denied.some(
          (r) => "root" in op.scope && containsPath(r, op.scope.root, local.deps.platform),
        ))
    )
      throw new RpcError(-32602, "Workspace write consent changed before confirmation");
  return WorkspaceSnapshotSchema.parse({
    boundaryVersion: 1,
    location: { target: "local", platform: local.deps.platform },
    roots,
    revision: captured.revision,
    primaryId: primary.id,
    primaryPath: primary.canonicalPath,
    ...(readonlySource ? { readonlySource } : {}),
    conflict: conflict ? "readonly_overlaps_primary" : "none",
    readRoots: roots.map((r) => r.canonicalPath),
    denyWriteRoots: denied,
    writeRoots: conflict ? [] : [primary.canonicalPath],
  });
}
