import { z } from "zod";

const name = z.string().min(1);
export const SafeSecretSchema = name.refine(
  (value) => value === value.trim() && !/[\r\n]/.test(value) && !value.startsWith("!"),
  "Unsafe secret value",
);
export const WebUrlSchema = z.url({ protocol: /^https?$/ });
