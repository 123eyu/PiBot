// Entries for the existing shared contract matrix; no independent test cases are defined here.

import type {
  DeliveryEvidenceMethods,
  ExecutionCollectionMethods,
  GroupExecutionMethods,
  ReviewExecutionMethods,
} from "@pibot/protocol-base";
import type { MethodParams, MethodResults } from "../../src/aggregate/api.ts";
import type { FileCheckpointMethods, ManagedWorktreeMethods } from "../../src/index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-16T00:00:00.000Z";
const target = { conversationKey: `dm:${id}`, topicId: id };
const scope = { botId: id, conversationId: id };
const tree = {
  id,
  botId: id,
  sourcePath: "/project",
  path: "/trees/project",
  branch: "pibot/worktrees/task",
  baseHead: "a".repeat(40),
  head: "b".repeat(40),
  state: "ready" as const,
  version: 1,
  createdAt: at,
  updatedAt: at,
  bindingRequired: true as const,
};
const checkpoint = {
  id,
  botId: id,
  runId: id,
  root: "/project",
  state: "available" as const,
  version: 1,
  createdAt: at,
  items: [],
  truncated: false,
};
const restore = {
  id,
  checkpointId: id,
  state: "done" as const,
  recoveryPath: "/project/.pibot-file-recovery/op",
  items: [],
  createdAt: at,
  updatedAt: at,
};
const _review = {
  id,
  ...scope,
  parentRunId: id,
  rootRunId: id,
  taskId: id,
  reviewerRunId: id,
  snapshotHash: "a".repeat(64),
  status: "done" as const,
  freshness: "current" as const,
  coverage: { complete: false, capturedFiles: 1, omitted: [] },
  findingsCount: 0,
  createdAt: at,
  updatedAt: at,
};
type Names =
  | keyof typeof GroupExecutionMethods
  | keyof typeof ExecutionCollectionMethods
  | keyof typeof ManagedWorktreeMethods
  | keyof typeof FileCheckpointMethods
  | keyof typeof ReviewExecutionMethods
  | keyof typeof DeliveryEvidenceMethods;
type Case<K extends keyof MethodParams> = {
  params: MethodParams[K];
  result: MethodResults[K];
  badParams: unknown;
  badResult: unknown;
};

export const workspaceMethodCases = {
  "worktrees.allocate": {
    params: { target },
    result: { id, parentPath: "/trees", expiresAt: at },
    badParams: { target, parentPath: "/arbitrary" },
    badResult: { id, parentPath: "/trees" },
  },
  "worktrees.list": {
    params: { target },
    result: { items: [tree], nextBefore: null },
    badParams: { target, limit: 0 },
    badResult: { items: [{ ...tree, version: 0 }], nextBefore: null },
  },
  "worktrees.views": {
    params: { target },
    result: {
      items: [
        {
          rootId: id,
          path: "/trees/project",
          name: "project",
          branch: "main",
          head: "a".repeat(40),
          locked: false,
          prunable: false,
          capabilities: { view: true, review: true, integrate: false, remove: false },
        },
      ],
      nextBefore: null,
    },
    badParams: { target, limit: 0 },
    badResult: { items: [], nextBefore: "bad" },
  },
  "worktrees.review": {
    params: { target, rootId: id },
    result: { runId: id, botId: id, conversationId: id, rootId: id, path: "/trees/project" },
    badParams: { target, rootId: "bad" },
    badResult: { runId: id },
  },
  "worktrees.create": {
    params: { target, allocationId: id, requestId: id, expectedSourceHead: "a".repeat(40) },
    result: tree,
    badParams: { target, allocationId: id },
    badResult: { ...tree, bindingRequired: false },
  },
  "worktrees.bind": {
    params: { target, id, expectedVersion: 1 },
    result: { ok: true },
    badParams: { target, id, expectedVersion: 0 },
    badResult: { ok: false },
  },
  "worktrees.recover": {
    params: { target, id },
    result: tree,
    badParams: { target, id: "bad" },
    badResult: { ...tree, state: "unknown" },
  },
  "worktrees.integrate": {
    params: {
      target,
      id,
      requestId: id,
      expectedVersion: 1,
      expectedTargetHead: "a".repeat(40),
      expectedWorktreeHead: "b".repeat(40),
    },
    result: tree,
    badParams: { target, id, requestId: id, expectedVersion: 1 },
    badResult: { ...tree, baseHead: "bad" },
  },
  "worktrees.remove": {
    params: { target, id, requestId: id, expectedVersion: 1 },
    result: tree,
    badParams: { target, id },
    badResult: { ...tree, head: "bad" },
  },
  "changes.checkpoints.forRun": {
    params: { target, runId: id },
    result: [(({ items: _, ...summary }) => ({ ...summary, rootId: "home" }))(checkpoint)],
    badParams: { target },
    badResult: [{ ...checkpoint, rootId: "home" }],
  },
  "changes.checkpoints.create": {
    params: { target, runId: id },
    result: checkpoint,
    badParams: { target },
    badResult: { ...checkpoint, version: 0 },
  },
  "changes.checkpoints.list": {
    params: { target },
    result: {
      items: [
        {
          id,
          botId: id,
          runId: id,
          root: "/project",
          state: "partial" as const,
          version: 1,
          createdAt: at,
          truncated: true,
        },
      ],
      nextBefore: null,
    },
    badParams: { target, limit: 0 },
    badResult: { items: [], nextBefore: "bad" },
  },
  "changes.checkpoints.get": {
    params: { target, id },
    result: checkpoint,
    badParams: { target, id: "bad" },
    badResult: { ...checkpoint, state: "done" },
  },
  "changes.checkpoints.restore": {
    params: { target, id, requestId: id, expectedVersion: 1, itemIds: [id] },
    result: restore,
    badParams: { target, id, requestId: id, expectedVersion: 1, itemIds: [] },
    badResult: { ...restore, state: "unknown" },
  },
  "changes.checkpoints.recover": {
    params: { target, restoreId: id },
    result: restore,
    badParams: { target },
    badResult: { ...restore, checkpointId: "bad" },
  },
  "changes.checkpoints.restores": {
    params: { target, id },
    result: { items: [restore], nextBefore: null },
    badParams: { target, id, limit: 0 },
    badResult: { items: [], nextBefore: "bad" },
  },
  "changes.checkpoints.resume": {
    params: { target, restoreId: id },
    result: restore,
    badParams: { target, restoreId: "bad" },
    badResult: { ...restore, id: "bad" },
  },
} satisfies Partial<{ [K in Names]: Case<K> }>;
