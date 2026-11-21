import { z } from "zod";

/** POSIX, drive-letter or UNC absolute path without control line breaks; both ACP sides use it. */
export const absolutePath = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (path) =>
      !/[\0\r\n]/.test(path) &&
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)),
    "Absolute path required",
  );
