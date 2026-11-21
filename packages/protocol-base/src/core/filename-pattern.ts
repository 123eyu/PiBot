import { z } from "zod";

// Filename-only wildcards have predictable cost; extglob and path traversal are not supported.
export const FilenamePatternSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      !/[/\\[\]{}()|!+@]/u.test(value),
    "Unsupported filename pattern",
  );
