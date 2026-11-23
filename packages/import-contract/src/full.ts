// Implementation handlers use concrete types without pulling in the product protocol.
import type { z } from "zod";
import type { ImportMethods } from "./index.ts";

export type ImportParams<K extends keyof typeof ImportMethods> = z.infer<
  (typeof ImportMethods)[K]["params"]
>;
