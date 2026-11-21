import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const BotHooksConfigSchema = z
  .strictObject({
    formatOnWrite: z.boolean(),
    formatCommand: z
      .string()
      .trim()
      .max(1000)
      .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), "One command line"),
    notifyOnCompletion: z.boolean(),
  })
  .refine(
    (value) => !value.formatOnWrite || value.formatCommand.length > 0,
    "A formatting command is required",
  );
export const BotHooksSettingsSchema = z.strictObject({
  botId: IdSchema,
  config: BotHooksConfigSchema,
});
export const BotHooksMethods = {
  "botHooks.get": {
    params: z.strictObject({ botId: IdSchema }),
    result: BotHooksSettingsSchema,
  },
  "botHooks.set": {
    params: BotHooksSettingsSchema,
    result: BotHooksSettingsSchema,
  },
} as const;
export const BotHooksEvents = {
  "botHooks.changed": z.strictObject({ botId: IdSchema }),
} as const;
export type BotHooksConfig = z.infer<typeof BotHooksConfigSchema>;
