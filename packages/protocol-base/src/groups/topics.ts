import { z } from "zod";
import { ConversationSchema, MessageSchema } from "../chat/entities.ts";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { GitOidSchema } from "../workspace/changes.ts";
import { ManagedWorktreeSchema } from "../workspace/managed-worktrees.ts";
import { FolderSelectionSchema } from "../workspace/workplaces.ts";
import { GroupFolderSchema, GroupRunnerFolderSchema, GroupSchema } from "./group.ts";
export const GroupTopicSchema = ConversationSchema.extend({
  folders: z.array(GroupFolderSchema).max(32),
  primaryFolderId: IdSchema.nullable(),
  workspaceRevision: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative().optional(),
  isCurrent: z.boolean().optional(),
  workplaceBusy: z.boolean().optional(),
});
export const GroupTopicMethods = {
  "groups.tasks.worktree.integrate": {
    params: z.strictObject({
      groupId: IdSchema,
      taskId: IdSchema,
      requestId: IdSchema,
      expectedVersion: z.number().int().positive().safe(),
      expectedTargetHead: GitOidSchema,
      expectedWorktreeHead: GitOidSchema,
    }),
    result: ManagedWorktreeSchema,
  },
  "groups.tasks.worktree.remove": {
    params: z.strictObject({
      groupId: IdSchema,
      taskId: IdSchema,
      requestId: IdSchema,
      expectedVersion: z.number().int().positive().safe(),
    }),
    result: ManagedWorktreeSchema,
  },
  "groups.topics.list": {
    params: PageSchema.extend({
      groupId: IdSchema,
      query: z.string().trim().max(200).optional(),
      archived: z.boolean().optional(),
    }),
    result: z.array(GroupTopicSchema).max(200),
  },
  "groups.topics.create": {
    params: z.strictObject({
      groupId: IdSchema,
      selectFolder: z.boolean().optional(),
      requestId: IdSchema.optional(),
      folderChoiceId: IdSchema.optional(),
      inheritWorkspace: z.boolean().optional(),
      selection: FolderSelectionSchema.optional(),
    }),
    result: GroupSchema,
  },
  "groups.topics.archive": {
    params: z.strictObject({ groupId: IdSchema, topicId: IdSchema }),
    result: GroupSchema,
  },
  "groups.topics.rename": {
    params: z.strictObject({
      groupId: IdSchema,
      topicId: IdSchema,
      title: z.string().trim().min(1).max(200),
    }),
    result: GroupTopicSchema,
  },
  "groups.topics.restore": {
    params: z.strictObject({ groupId: IdSchema, topicId: IdSchema }),
    result: GroupTopicSchema,
  },
  "groups.topics.switch": {
    params: z.strictObject({ groupId: IdSchema, topicId: IdSchema }),
    result: GroupSchema,
  },
  "groups.topics.pickFolder": {
    params: GroupRunnerFolderSchema.safeExtend({ groupId: IdSchema }),
    result: z
      .strictObject({
        choiceId: IdSchema,
        path: z.string(),
        name: z.string(),
        location: GroupFolderSchema.shape.location,
      })
      .nullable(),
  },
  "groups.topics.history": {
    params: PageSchema.extend({ groupId: IdSchema, topicId: IdSchema }),
    result: z.array(MessageSchema),
  },
} as const;
export type GroupTopic = z.infer<typeof GroupTopicSchema>;
