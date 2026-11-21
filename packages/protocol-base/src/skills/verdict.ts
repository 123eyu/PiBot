import { z } from "zod";

export const ReportVerdictSchema = z.strictObject({
  verdict: z.enum(["pass", "fail"]),
  failures: z.array(z.string().min(1).max(200)).max(10),
});
export type ReportVerdict = z.infer<typeof ReportVerdictSchema>;
