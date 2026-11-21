import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const text = z.string().min(1);
const botId = z.strictObject({ botId: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
export const FileMethods = {
  "files.open": { params: botId.extend({ path: text }), result: ok },
} as const;
