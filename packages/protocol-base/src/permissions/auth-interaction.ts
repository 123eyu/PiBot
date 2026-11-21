import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const providerId = z.string().min(1).max(200);
export const LoginStepSchema = z.strictObject({
  providerId,
  promptId: IdSchema,
  kind: z.enum(["select", "text", "manual_code", "device_code", "browser"]),
  options: z
    .array(z.enum(["browser", "copy_code", "device_code"]))
    .max(3)
    .optional(),
  // This is the displayed verification code, never the device_auth_id or OAuth authorization code.
  userCode: z
    .string()
    .regex(/^[A-Za-z0-9 -]{1,32}$/)
    .optional(),
});
export type LoginStep = z.infer<typeof LoginStepSchema>;
