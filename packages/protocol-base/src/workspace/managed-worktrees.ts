import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { GitOidSchema } from "./changes.ts";

export const ManagedWorktreeStateSchema = z.enum([
  "creating",
  "ready",
  "integrating",
  "removing",
  "removed",
  "interrupted",
  "conflict",
]);
export const ManagedWorktreeSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  sourcePath: z.string().max(4096),
  path: z.string().max(4096),
  branch: z.string().max(200),
  baseHead: GitOidSchema,
  head: GitOidSchema.nullable(),
  /** Live inspection only; omitted when verification is unavailable, never persisted. */
  clean: z.boolean().optional(),
  sourceHead: GitOidSchema.optional(),
  sourceClean: z.boolean().optional(),
  /** Task-owned workspaces use their separate group lifecycle, never manual owner mutation. */
  taskId: IdSchema.optional(),
  integrationPath: z.string().max(4096).optional(),
  state: ManagedWorktreeStateSchema,
  version: z.number().int().positive().safe(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Execution binding is a separate capability; browsing never issues one. */
  bindingRequired: z.literal(true),
});
export const WorktreeAllocationSchema = z.strictObject({
  id: IdSchema,
  parentPath: z.string().max(4096),
  expiresAt: z.iso.datetime(),
});
export const WorktreeViewSchema = z.strictObject({
  rootId: IdSchema,
  path: z.string().max(4096),
  name: z.string().max(4096),
  branch: z.string().max(4096).nullable(),
  head: GitOidSchema.nullable(),
  locked: z.boolean(),
  prunable: z.boolean(),
  /** Git's main worktree, for display only; this never grants management authority. */
  isMain: z.boolean().optional(),
  managed: ManagedWorktreeSchema.optional(),
  groupId: IdSchema.optional(),
  sourceConversationId: IdSchema.optional(),
  capabilities: z.strictObject({
    view: z.boolean(),
    review: z.boolean(),
    integrate: z.boolean(),
    remove: z.boolean(),
    recover: z.boolean().optional(),
    reason: z.string().max(100).optional(),
  }),
});
export type ManagedWorktree = z.infer<typeof ManagedWorktreeSchema>;
export type WorktreeAllocation = z.infer<typeof WorktreeAllocationSchema>;
export type WorktreeView = z.infer<typeof WorktreeViewSchema>;
