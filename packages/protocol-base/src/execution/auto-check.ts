import { z } from "zod";
import { ChatNoticeSchema } from "../chat/notices.ts";
import { IdSchema } from "../core/ids.ts";

/** Follow-up fix rounds after a failed check. */
export const AUTO_CHECK_DEFAULT_ROUNDS = 2;
export const AutoCheckRoundsSchema = z.number().int().min(0).max(3);
/**
 * One check command as the user (or the Bot's proposal) wrote it: a single line. It is run exactly
 * like a Bot's `run_command`, so the same policy, approval card and isolation apply.
 */
export const AutoCheckCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), "One line without control characters");
export const AutoCheckCommandsSchema = z.array(AutoCheckCommandSchema).min(1).max(3);

/** A Bot's automatic check switch. `stored: false` = never set (off). */
export const AutoCheckSettingsSchema = z.strictObject({
  botId: IdSchema,
  enabled: z.boolean(),
  rounds: AutoCheckRoundsSchema,
  stored: z.boolean(),
});
/**
 * The check commands of a conversation's primary folder. `commands: null` = not known yet (the
 * Bot proposes some the first time), `[]` = the user chose not to check this folder.
 */
export const AutoCheckFolderSchema = z.strictObject({
  botId: IdSchema,
  conversationId: IdSchema,
  /** The folder, as the folder picker shows it; null when it cannot be resolved now. */
  folder: z
    .strictObject({
      name: z.string().max(400),
      path: z.string().max(32_768),
      /** The Bot's own folder, shown by its label rather than its path. */
      home: z.boolean(),
    })
    .nullable(),
  commands: z.array(AutoCheckCommandSchema).max(3).nullable(),
});
const botId = z.strictObject({ botId: IdSchema });
/** A DM topic, a group conversation or a task thread the Bot works in. */
const place = botId.extend({ conversationId: IdSchema });

export const AutoCheckMethods = {
  "autoCheck.get": { params: botId, result: AutoCheckSettingsSchema },
  "autoCheck.set": {
    params: botId
      .extend({ enabled: z.boolean().optional(), rounds: AutoCheckRoundsSchema.optional() })
      .refine((v) => v.enabled !== undefined || v.rounds !== undefined, "Nothing to change"),
    result: AutoCheckSettingsSchema,
  },
  "autoCheck.folder.get": { params: place, result: AutoCheckFolderSchema },
  /** `commands: null` forgets the folder's commands (the Bot proposes again next time). */
  "autoCheck.folder.set": {
    params: place.extend({
      commands: z.array(AutoCheckCommandSchema).max(3).nullable(),
    }),
    result: AutoCheckFolderSchema,
  },
  /**
   * Turns automatic checks off (or back on) for one conversation while the brain runs. Only ACP
   * task topics use it (maintainers 2026-11-05): the client runs its own checks after the turn, so a
   * second round inside the turn only costs time. Not stored: ACP re-sends it on session/load.
   */
  "autoCheck.conversation.set": {
    params: z.strictObject({ conversationId: IdSchema, enabled: z.boolean() }),
    result: z.strictObject({ conversationId: IdSchema, enabled: z.boolean() }),
  },
  /** The user's answer on a proposal card; `commands` replaces the proposed ones when edited. */
  "autoCheck.proposal.resolve": {
    params: z.strictObject({
      noticeId: IdSchema,
      accept: z.boolean(),
      commands: AutoCheckCommandsSchema.optional(),
    }),
    result: ChatNoticeSchema,
  },
} as const;
export const AutoCheckEvents = {
  /** Settings of a Bot or the commands of some folder changed; listeners re-read what they show. */
  "autoCheck.changed": z.strictObject({
    botId: IdSchema.optional(),
    reason: z.enum(["settings", "folder"]),
  }),
} as const;
export type AutoCheckSettings = z.infer<typeof AutoCheckSettingsSchema>;
export type AutoCheckFolder = z.infer<typeof AutoCheckFolderSchema>;
