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
const scope = { botId: id, conversationId: id };
const review = {
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
const evidence = {
  id,
  ...scope,
  rootRunId: id,
  runId: id,
  createdAt: at,
  codeHash: null,
  kind: "command" as const,
  toolRecordId: id,
  toolCallId: "call_1",
  toolStatus: "done",
  exitCode: 0,
  durationMs: 1,
  finishedAt: at,
  logAvailable: true,
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

export const executionMethodCases = {
  "execution.collection.change": {
    params: { ...scope, kind: "plan", action: "archive", expectedVersion: 1 },
    result: { ok: true },
    badParams: { ...scope, kind: "task", action: "delete", expectedVersion: 1 },
    badResult: { ok: false },
  },
  "execution.plans.archived": {
    params: scope,
    result: { items: [], nextBefore: null },
    badParams: { ...scope, limit: 0 },
    badResult: { items: [], nextBefore: "invalid" },
  },
  "reviewExecutions.list": {
    params: scope,
    result: { items: [review], next: null },
    badParams: { botId: id },
    badResult: { items: [{ ...review, snapshotHash: "bad" }], next: null },
  },
  "reviewExecutions.get": {
    params: { ...scope, id },
    result: review,
    badParams: { ...scope, id: "bad" },
    badResult: { ...review, freshness: "unchecked" },
  },
  "reviewExecutions.findings": {
    params: { ...scope, id },
    result: {
      reviewId: id,
      snapshotHash: "a".repeat(64),
      freshness: "current",
      findings: [],
      truncated: false,
    },
    badParams: { ...scope, id: "bad" },
    badResult: {
      reviewId: id,
      snapshotHash: "bad",
      freshness: "current",
      findings: [],
      truncated: false,
    },
  },
  "deliveryEvidence.list": {
    params: scope,
    result: { items: [evidence], next: null },
    badParams: { ...scope, limit: 0 },
    badResult: { items: [{ ...evidence, exitCode: 0.5 }], next: null },
  },
  "deliveryEvidence.get": {
    params: { ...scope, id },
    result: evidence,
    badParams: scope,
    badResult: { ...evidence, codeHash: "bad" },
  },
} satisfies Partial<{ [K in Names]: Case<K> }>;

export const executionEventCases = {
  "execution.collection.changed": { payload: scope, bad: { botId: id } },
  "review.execution.changed": { payload: { ...scope, id }, bad: { ...scope, id: "bad" } },
  "delivery.evidence.changed": { payload: { ...scope, id }, bad: { botId: id, id } },
};
