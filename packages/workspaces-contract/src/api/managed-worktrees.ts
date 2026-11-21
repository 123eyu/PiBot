import {
  ChangesTargetSchema,
  GitOidSchema,
  IdSchema,
  ManagedWorktreeSchema,
  WorktreeAllocationSchema,
  WorktreeViewSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const target = ChangesTargetSchema;
const version = z.number().int().positive().safe();
export const ManagedWorktreeMethods = {
  "worktrees.views": {
    params: z.strictObject({
      target,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    result: z.strictObject({
      items: z.array(WorktreeViewSchema).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "worktrees.review": {
    params: z.strictObject({ target, rootId: IdSchema }),
    result: z.strictObject({
      runId: IdSchema,
      botId: IdSchema,
      conversationId: IdSchema,
      rootId: IdSchema,
      path: z.string().max(4096),
    }),
  },
  /** Core-issued project-local allocation; never exposed as an agent tool. */
  "worktrees.allocate": {
    params: z.strictObject({ target }),
    result: WorktreeAllocationSchema.nullable(),
  },
  "worktrees.list": {
    params: z.strictObject({
      target,
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    result: z.strictObject({
      items: z.array(ManagedWorktreeSchema).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "worktrees.create": {
    params: z.strictObject({
      target,
      allocationId: IdSchema,
      requestId: IdSchema,
      expectedSourceHead: GitOidSchema,
    }),
    result: ManagedWorktreeSchema,
  },
  "worktrees.integrate": {
    params: z.strictObject({
      target,
      id: IdSchema,
      requestId: IdSchema,
      expectedVersion: version,
      expectedTargetHead: GitOidSchema,
      expectedWorktreeHead: GitOidSchema,
    }),
    result: ManagedWorktreeSchema,
  },
  "worktrees.bind": {
    params: z.strictObject({ target, id: IdSchema, expectedVersion: version }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "worktrees.recover": {
    params: z.strictObject({ target, id: IdSchema }),
    result: ManagedWorktreeSchema,
  },
  "worktrees.remove": {
    params: z.strictObject({ target, id: IdSchema, requestId: IdSchema, expectedVersion: version }),
    result: ManagedWorktreeSchema,
  },
} as const;
