import type { z } from "zod";
import type { computerSchemas } from "./computer-tools.ts";
export type ComputerInput = {
  [K in keyof typeof computerSchemas]: { tool: K; args: z.infer<(typeof computerSchemas)[K]> };
}[keyof typeof computerSchemas];
