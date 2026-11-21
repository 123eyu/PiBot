import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { FolderSelectionSchema, WorkplacesSchema } from "../workspace/workplaces.ts";

/** `null` used to mean "follow the Bot"; now it means the Bot's own folder (`home`). */
export const TopicFolderIdSchema = z.union([z.literal("home"), IdSchema]).nullable();
export const TopicWorkplaceSnapshotSchema = z.strictObject({
  conversationId: IdSchema,
  folderId: TopicFolderIdSchema,
  revision: z.number().int().nonnegative().safe(),
});
export type TopicWorkplaceSnapshot = z.infer<typeof TopicWorkplaceSnapshotSchema>;
const target = z.strictObject({ botId: IdSchema, topicId: IdSchema });
const result = z.strictObject({
  topicId: IdSchema,
  folderId: TopicFolderIdSchema,
  revision: z.number().int().nonnegative().safe(),
  busy: z.boolean(),
  workplace: WorkplacesSchema,
  /** The topic's read-only references (the primary is `folderId`). */
  readonly: z.array(IdSchema).max(32).optional(),
  writable: z.array(IdSchema).max(4).optional(),
  /**
   * The topic's folder is on a runner that is offline: `workplace` is the stored choice, not a
   * resolved boundary, so the picker can still move the topic back to this computer.
   */
  runnerOffline: z.boolean().optional(),
});
export const TopicWorkplaceMethods = {
  "topics.workplace.get": { params: target, result },
  /**
   * An ACP client continues an existing topic instead of opening a new one. The brain checks
   * the topic belongs to this Bot, is not archived, and that `cwd` is one of its folders; it
   * answers with fixed codes so the client never learns the topic's title or content.
   */
  "topics.acp.attach": {
    params: target.extend({ cwd: z.string().min(1).max(32768) }),
    result: z.strictObject({ topicId: IdSchema }),
  },
  /** Sets the primary folder and keeps the read-only references. */
  "topics.workplace.set": {
    params: target.extend({ folderId: TopicFolderIdSchema }),
    result,
  },
  // The topic's whole selection; refused with `busy` while the Bot works in the topic.
  "topics.workplace.update": {
    params: target.extend({
      selection: FolderSelectionSchema,
      /** ACP ownership is permanent even when its folders are later promoted to user roots. */
      acpSession: z.literal(true).optional(),
    }),
    result,
  },
  // What a new topic of this Bot starts with (the previous topic's folders).
  "topics.workplace.initial": {
    params: z.strictObject({ botId: IdSchema }),
    result: z.strictObject({ selection: FolderSelectionSchema, workplace: WorkplacesSchema }),
  },
};
