import {
  SKILL_SOURCE_FIELDS,
  SKILL_TOOL_MAPPING,
  type SkillCompatibilityEntry,
  type SkillCompatibilityReport,
} from "@pibot/skills-contract/full";

export interface SkillCompatibilityInput {
  /** Keys of the original frontmatter, including extensions with list/map values. */
  frontmatter: Readonly<Record<string, unknown>>;
  body: string;
  /** Values written in `allowed-tools`; names only, anything else is dropped. */
  allowedTools?: readonly string[];
  /** Text of documents SKILL.md points at (references/*.md), scanned like the body. */
  documents?: readonly string[];
  files: readonly { path: string }[];
  filesUnavailable?: boolean;
}

const STANDARD = new Set(["name", "description", "license", "metadata", "compatibility"]);
const SYSTEM_DIRECTORIES = new Set([
  "tmp",
  "var",
  "etc",
  "usr",
  "bin",
  "sbin",
  "opt",
  "dev",
  "proc",
  "sys",
  "home",
  "root",
  "mnt",
  "media",
  "run",
  "srv",
  "lib",
  "lib64",
  "private",
  "users",
  "volumes",
  "applications",
  "system",
  "library",
]);
/** A tool name is only a tool when it is written as one; see `usesTool`. */
const TOOL_VALUE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** Words that make a subagent mention a suggestion; the skill still works without it. */
const OPTIONAL =
  /\boptional(?:ly)?\b|\bif\s+available\b|\bnice\s+to\s+have\b|\brecommended\b|\bpreferred\b|\bbonus\b|可选|可选地|如果需要|有的话|更好/i;
const RUNTIMES = [
  { runtime: "python", extension: /\.pyw?$/i },
  { runtime: "node", extension: /\.(?:[cm]?[jt]s|jsx|tsx)$/i },
  { runtime: "bash", extension: /\.(?:sh|bash|zsh)$/i },
  { runtime: "powershell", extension: /\.(?:ps1|psm1)$/i },
] as const;

/**
 * Heuristic advice, never an execution plan. Only fixed codes and vocabulary leave this module:
 * matching text, paths, command arguments and environment values are deliberately not returned.
 */
export function skillCompatibility(input: SkillCompatibilityInput): SkillCompatibilityReport {
  const report: SkillCompatibilityReport = { unavailable: [], partial: [], notice: [] };
  const add = (
    severity: keyof SkillCompatibilityReport,
    code: SkillCompatibilityEntry["code"],
    params: SkillCompatibilityEntry["params"] = {},
  ) => report[severity].push({ code, params });
  for (const field of SKILL_SOURCE_FIELDS) {
    if (!Object.hasOwn(input.frontmatter, field)) continue;
    if (STANDARD.has(field)) add("notice", "standard_field", { field });
    else if (field === "allowed-tools") add("partial", "allowed_tools", { field });
    else add("partial", "ignored_field", { field });
  }
  for (const [tool, replacement] of Object.entries(SKILL_TOOL_MAPPING)) {
    // Listing a tool in allowed-tools is the skill saying it uses it; prose is not.
    if ((input.allowedTools ?? []).includes(tool) || usesTool(input.body, tool))
      add("notice", "tool_mapping", { tool: tool as keyof typeof SKILL_TOOL_MAPPING, replacement });
  }
  if (input.allowedTools?.length)
    add("partial", "allowed_tools", { field: "allowed-tools", tools: [...input.allowedTools] });
  // A referenced document is read by the skill, so its commands matter as much as SKILL.md's own.
  const texts = [input.body, ...(input.documents ?? [])].join("\n");
  for (const tool of ["claude", "codex"] as const) {
    // Avoid treating the product name in ordinary prose as a CLI dependency.
    const command = new RegExp(
      `(?:^|[\\n\x60])[ \\t]*(?:\\$[ \\t]+)?(?:[\\w./\\\\:-]+[/\\\\])?${tool}(?:\\.exe|\\.cmd)?(?=[ \\t\x60]|$)`,
      "m",
    );
    if (command.test(texts)) add("unavailable", "cli", { tool });
  }
  if (hasSlashCommand(texts)) add("unavailable", "slash_command");
  if (wantsSubagent(texts)) add("unavailable", "subagent");
  if (/\$(?:CLAUDE_[A-Z0-9_]+|\{CLAUDE_[A-Z0-9_]+\})/.test(input.body))
    add("unavailable", "claude_environment");
  if (/(?:~\/\.claude\b|%USERPROFILE%[\\/]\.claude\b)/i.test(input.body))
    add("unavailable", "claude_path");
  const present = new Set<string>();
  for (const file of input.files) {
    for (const { runtime, extension } of RUNTIMES)
      if (extension.test(file.path)) present.add(runtime);
  }
  for (const { runtime } of RUNTIMES)
    if (present.has(runtime)) add("notice", "interpreter", { runtime });
  if (present.has("bash") && !present.has("powershell")) add("partial", "shell_windows");
  if (input.filesUnavailable) add("notice", "files_unavailable");
  return report;
}

/**
 * Prose like "Read this file" or "Edit the deck" is an English verb, not a tool dependency.
 * Only a name written as one counts: in a code span (`Read`, `Read(...)`) or named as a tool
 * ("Read tool", "Read 工具").
 */
function usesTool(text: string, tool: string) {
  return (
    new RegExp(`\`s*${tool}s*(?:\\([^\`]*)?\``).test(text) ||
    new RegExp(`\\b${tool}\\s*(?:tool\\b|工具)`).test(text)
  );
}

/** Values written in `allowed-tools`, kept only when they look like a tool name. */
export function allowedToolValues(value: unknown): string[] {
  // A skill without allowed-tools must not show the literal string "undefined" as a tool.
  if (value === undefined || value === null || typeof value === "object") return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  const names = items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => TOOL_VALUE.test(item));
  return [...new Set(names)].slice(0, 32);
}

/** 「有 subagent 更好」 is an option, not a requirement; only an instruction to use one is.
 * A bare mention used to be reported as unavailable, which warned people off skills that work. */
function wantsSubagent(text: string) {
  for (const match of text.matchAll(
    /\bTask\s*(?:tool\b|\()|\bsubagent_type\b|\b[Uu]se\s+the\s+Task\b(?!\s+(?:list|title|section)\b)|\b(?:[Uu]se|spawn|launch|run|dispatch)\s+(?:a\s+|an\s+|the\s+)?sub[- ]?agents?\b|(?:使用|调用|启动|开一个)\s*子代理/g,
  )) {
    // The same sentence deciding whether it is optional is enough: the skill still works without it.
    const sentence = sentenceAt(text, match.index ?? 0);
    if (!OPTIONAL.test(sentence)) return true;
  }
  return false;
}

function sentenceAt(text: string, index: number) {
  const before = text.lastIndexOf("\n", index);
  const end = text.indexOf("\n", index);
  return text.slice(before + 1, end === -1 ? undefined : end);
}

function hasSlashCommand(body: string) {
  // Match whole code spans: a closing backtick followed by /options is ordinary prose.
  for (const span of body.matchAll(/(?<!`)`([^`\r\n]+)`(?!`)/g)) {
    const match = /^\s*\/([a-z][\w:-]*)(?=[ \t]|$)/.exec(span[1] as string);
    if (match && !SYSTEM_DIRECTORIES.has((match[1] as string).toLowerCase())) return true;
  }
  // Outside code spans, require a command line or an explicit instruction to run/type one.
  for (const match of body.matchAll(
    /(?:^[ \t]*|\b(?:run|enter|type)[ \t]+|(?:运行|输入|执行)[ \t]*)\/([a-z][\w:-]*)(?=[ \t]|$)/gm,
  )) {
    if (!SYSTEM_DIRECTORIES.has((match[1] as string).toLowerCase())) return true;
  }
  return false;
}

/** Values are immaterial; this adapter also accepts field names preserved by normalization. */
export function compatibilityFrontmatter(fields: readonly string[] | undefined) {
  return Object.fromEntries((fields ?? []).map((field) => [field, true]));
}
