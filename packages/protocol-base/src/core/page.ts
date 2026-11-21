import { z } from "zod";
import { IdSchema } from "./ids.ts";

const count = z.number().int().nonnegative().safe();
export const PageSchema = z.strictObject({
  before: IdSchema.optional(),
  limit: count.positive().max(200).optional(),
});
export const BotPageSchema = PageSchema.extend({ botId: IdSchema.optional() });
const _botId = z.strictObject({ botId: IdSchema });
export type Page = z.infer<typeof PageSchema>;
export type BotPage = z.infer<typeof BotPageSchema>;
