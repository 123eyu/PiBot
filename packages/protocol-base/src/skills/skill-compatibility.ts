import { z } from "zod";

/** Names only: foreign frontmatter values never become Pi Bot configuration or authority. */
export const SKILL_SOURCE_FIELDS = [
  "name",
  "description",
  "license",
  "metadata",
  "compatibility",
  "allowed-tools",
  "model",
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "context",
  "agent",
  "hooks",
  "argument-dependent",
] as const;
export const SkillSourceFieldsSchema = z
  .array(z.enum(SKILL_SOURCE_FIELDS))
  .max(SKILL_SOURCE_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length);

/** Shared by the advisory checker and the fixed model-facing guidance. */
export const SKILL_TOOL_MAPPING = {
  Bash: "run_command",
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Glob: "find_files",
  Grep: "search_text",
  WebFetch: "web_fetch",
} as const;

export const SkillCompatibilityCodeSchema = z.enum([
  "standard_field",
  "ignored_field",
  "allowed_tools",
  "tool_mapping",
  "cli",
  "slash_command",
  "subagent",
  "claude_environment",
  "claude_path",
  "interpreter",
  "shell_windows",
  "files_unavailable",
]);
export const SkillCompatibilityEntrySchema = z.strictObject({
  code: SkillCompatibilityCodeSchema,
  // All producers use fixed vocabulary; no excerpts, file paths or environment values.
  params: z.strictObject({
    field: z.enum(SKILL_SOURCE_FIELDS).optional(),
    tool: z
      .enum(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "claude", "codex"])
      .optional(),
    replacement: z
      .enum([
        "run_command",
        "read_file",
        "write_file",
        "edit_file",
        "find_files",
        "search_text",
        "web_fetch",
      ])
      .optional(),
    runtime: z.enum(["python", "node", "bash", "powershell"]).optional(),
    /**
     * The values written in `allowed-tools`. Names only, and never free text: a skill cannot
     * smuggle a sentence (or a secret) into the report by putting it in that list.
     */
    tools: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/))
      .max(32)
      .optional(),
  }),
});
export const SkillCompatibilityReportSchema = z.strictObject({
  unavailable: z.array(SkillCompatibilityEntrySchema).max(64),
  partial: z.array(SkillCompatibilityEntrySchema).max(64),
  notice: z.array(SkillCompatibilityEntrySchema).max(64),
});
export type SkillCompatibilityEntry = z.infer<typeof SkillCompatibilityEntrySchema>;
export type SkillCompatibilityReport = z.infer<typeof SkillCompatibilityReportSchema>;
