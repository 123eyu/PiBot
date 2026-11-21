import { resolve as pathResolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RunFileChangesRepo, RunReceiptRepo, RunRecoveryRepo, RunsRepo } from "@pibot/storage";
import type { DeliverySources } from "./delivery-citations.ts";
import type { WorkflowRun } from "./workflow-prepare.ts";

/**
 * Provenance an orchestrator vouches for: the kernel only reads run receipts and file
 * changes, it never interprets an orchestrator's plan snapshot. `attempts` are earlier rounds of
 * the same deliverable (their writes are this step's own output, so never a source); `runs` are
 * upstream producers whose fetches and reads count; `files` / `folders` are declared inputs.
 */
export interface DeliveryProvenance {
  runs: readonly string[];
  attempts: readonly string[];
  files: readonly string[];
  folders: readonly string[];
  workspaceRoot?: string;
  artifactRoot?: string;
  incomplete?: boolean;
}

const TREE_RUNS = 200;
const TREE_DEPTH = 4;

/** Read-only provenance projection; never adds fields to D3's plan/progress snapshots. */
export function deliverySources(
  db: DatabaseSync,
  runId: string,
  inputs: WorkflowRun["inputs"] = [],
  provenance?: DeliveryProvenance,
  workspaceRoot = provenance?.workspaceRoot,
  access?: import("../../resources/workplaces/workspace-files.ts").WorkspaceFileAccess,
): DeliverySources {
  const resolve = access?.paths.resolve ?? pathResolve;
  const webDigests = new Set<string>();
  const files = new Set(inputs.filter((item) => item.kind === "file").map((item) => item.value));
  const folders = inputs.filter((item) => item.kind === "folder").map((item) => item.value);
  for (const file of provenance?.files ?? []) files.add(file);
  folders.push(...(provenance?.folders ?? []));
  const runs = new RunsRepo(db);
  const current = runs.get(runId);
  const own = new Set([runId]);
  const recoveries = new RunRecoveryRepo(db);
  const recovery = recoveries.root(runId);
  let previous = recoveries.get(runId)?.resumedFrom;
  for (let count = 0; previous && count < 20 && !own.has(previous); count++) {
    const run = runs.get(previous);
    if (run?.groupId !== current?.groupId || run?.botId !== current?.botId) break;
    own.add(previous);
    previous = recoveries.get(previous)?.resumedFrom;
  }
  if (recovery) own.add(recovery);
  for (const id of provenance?.attempts ?? []) own.add(id);
  let incomplete = provenance?.incomplete ?? false;
  // Execution children and continuations do the reading for their parent; a step's sources
  // include them. Bounded: a tree too large to read is incomplete evidence, never a pass.
  const tree = (seed: Iterable<string>, seen: Set<string>) => {
    const candidates = [...seed].filter((id) => !seen.has(id));
    if (candidates.length > TREE_RUNS - seen.size) incomplete = true;
    let frontier = candidates.slice(0, Math.max(0, TREE_RUNS - seen.size));
    for (const id of frontier) seen.add(id);
    for (let depth = 0; frontier.length && depth < TREE_DEPTH; depth++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const child of runs.childIds(id)) {
          if (seen.has(child)) continue;
          if (seen.size >= TREE_RUNS) {
            incomplete = true;
            return;
          }
          seen.add(child);
          next.push(child);
        }
      frontier = next;
    }
    if (frontier.some((id) => runs.childIds(id, 1).length)) incomplete = true;
  };
  const ownTree = new Set<string>();
  tree(own, ownTree);
  const changes = new RunFileChangesRepo(db);
  const excludedFiles = [...ownTree].flatMap((id) =>
    changes.summarize(id).map((item) => resolve(item.root, item.path)),
  );
  const ids = new Set(ownTree);
  tree(provenance?.runs ?? [], ids);
  const receipts = new RunReceiptRepo(db);
  for (const id of ids) {
    const run = runs.get(id);
    // Execution children run in internal, group-less conversations under a group parent.
    if (!run || (run.groupId && run.groupId !== current?.groupId)) continue;
    const audit = receipts.audit(id);
    incomplete ||= audit.truncated;
    for (const { kind, detail } of audit.rows) {
      if (kind === "web.fetched" && detail.sourceDigest) webDigests.add(detail.sourceDigest);
      if (kind === "file.read" && detail.path) files.add(detail.path);
    }
  }
  return {
    access,
    webDigests,
    files: [...files],
    folders,
    excludedFiles,
    incomplete,
    ...(workspaceRoot ? { workspaceRoots: [workspaceRoot] } : {}),
    ...(provenance?.artifactRoot ? { artifactRoots: [provenance.artifactRoot] } : {}),
  };
}
