import { z } from "zod";

const label = z.string().max(200);
const id = z.string().max(80);
/**
 * Avatar fields as the real UI stores them. Custom images are data URLs (image content), so only
 * whether one exists is kept; the cached screen draws a same-size placeholder in its place.
 */
const look = z.strictObject({
  shape: z.string().max(32),
  color: z.string().max(32),
  eyes: z.string().max(32),
  image: z.boolean().optional(),
});
/** GroupAvatar draws at most four members; the count only feeds its "+N" tile. */
const members = {
  members: z.array(look).max(4).optional(),
  memberCount: z.number().int().min(0).max(100).optional(),
};
// Every field added after version 1 is optional so a snapshot from the previous build still
// parses; anything else unreadable is treated as no cache by the store.
export const StartupSnapshotSchema = z.strictObject({
  version: z.literal(1),
  language: z.enum(["system", "zh", "en"]),
  theme: z.enum(["system", "light", "dark"]),
  entries: z
    .array(
      z.strictObject({
        key: id,
        name: label,
        unread: z.boolean(),
        pinned: z.boolean().optional(),
        main: z.boolean().optional(),
        sectionId: id.optional(),
        time: z.iso.datetime().optional(),
        preview: label.optional(),
        failed: z.boolean().optional(),
        avatar: look.optional(),
        ...members,
      }),
    )
    .max(50),
  sections: z
    .array(z.strictObject({ id, name: label, collapsed: z.boolean() }))
    .max(50)
    .optional(),
  inboxCount: z.number().int().min(0).max(1_000_000),
  userAvatarImage: z.boolean().optional(),
  background: z
    .enum([
      "workspace.background",
      "workspace.backgroundNever",
      "workspace.backgroundOnAc",
      "workspace.backgroundAlways",
    ])
    .optional(),
  conversation: z
    .strictObject({
      botId: z.uuid().optional(),
      groupId: z.uuid().optional(),
      topicId: z.uuid().optional(),
      name: label,
      avatar: look.optional(),
      ...members,
      /** True when the cached messages start at the beginning of the topic. */
      complete: z.boolean().optional(),
      messages: z
        .array(
          z.strictObject({
            id: z.string().max(100),
            role: z.enum(["user", "assistant"]),
            text: z.string().max(4000),
            at: z.iso.datetime().optional(),
            sender: z.strictObject({ name: label, avatar: look }).optional(),
          }),
        )
        .max(20),
    })
    .optional(),
});
export type StartupSnapshot = z.infer<typeof StartupSnapshotSchema>;
export type StartupAvatarLook = z.infer<typeof look>;
export const STARTUP_SNAPSHOT_CHANNEL = "pibot:startup-snapshot";
