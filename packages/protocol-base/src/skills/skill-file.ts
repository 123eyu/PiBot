import { z } from "zod";
import { SkillVersionSchema } from "./contract.ts";
import { SKILL_SOURCE_FIELDS, SkillSourceFieldsSchema } from "./skill-compatibility.ts";
import { SkillLinkOriginSchema } from "./skill-link-origin.ts";
import {
  SKILL_CONTRACT_MAX_CHARS,
  SKILL_SOURCE_VERSION_MAX_CHARS,
  SKILL_VERIFIED_MAX_CHARS,
  type SkillDocument,
  type SkillDocumentInput,
  SkillDocumentSchema,
  type SkillParam,
  SkillParamSchema,
} from "./skills.ts";

// Plain text only (no node:crypto): the brain saves and loads with it and the renderer's
// SKILL.md editor parses with the same code, so both agree on what a file means.

/**
 * SKILL.md in Agent Skills form. `name` is the folder slug (the format requires it to match the
 * folder); Pi Bot's display name and `{parameter}` defaults live under `metadata` so the model sees
 * them when it reads the file. Values are JSON strings, which are valid double-quoted YAML.
 */
export function renderSkillFile(slug: string, document: SkillDocument): string {
  const lines = [
    "---",
    `name: ${slug}`,
    `description: ${JSON.stringify(oneLine(document.description))}`,
    "metadata:",
    `  pibot-name: ${JSON.stringify(document.name)}`,
  ];
  if (document.version !== undefined)
    lines.push(`  pibot-version: ${JSON.stringify(String(document.version))}`);
  if (document.sourceVersion !== undefined)
    lines.push(`  pibot-source-version: ${JSON.stringify(document.sourceVersion)}`);
  if (document.params.length)
    lines.push(`  pibot-params: ${JSON.stringify(JSON.stringify(document.params))}`);
  // The contract stays exactly as written (one JSON string), valid or not.
  if (document.contract !== undefined)
    lines.push(`  pibot-contract: ${JSON.stringify(document.contract)}`);
  if (document.verified !== undefined)
    lines.push(`  pibot-verified: ${JSON.stringify(document.verified)}`);
  if (document.sourceFields !== undefined)
    lines.push(`  pibot-source-fields: ${JSON.stringify(JSON.stringify(document.sourceFields))}`);
  if (document.linkOrigin !== undefined)
    lines.push(`  pibot-link-origin: ${JSON.stringify(JSON.stringify(document.linkOrigin))}`);
  lines.push("---", "", document.body);
  return lines.join("\n");
}

export function oneLine(text: string) {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}
export function flat(text: string) {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

export interface ParsedSkillFile {
  /** Includes list/map keys ignored by the scalar parser; only recognized names are retained. */
  sourceFields?: NonNullable<SkillDocument["sourceFields"]>;
  fields: Record<string, string>;
  metadata: Record<string, string>;
  body: string;
  /** False when the text has no complete `---` front matter (everything is body then). */
  frontMatter: boolean;
}

/**
 * Reads the YAML subset SKILL.md files use: top-level `key: value` scalars (plain, quoted or `|`/`>`
 * blocks) and one level under `metadata:`. Anything else (lists, `allowed-tools`, nested maps) is
 * ignored: it never grants anything and Pi Bot does not need it.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  if (!normalized.startsWith("---\n"))
    return { fields, metadata, body: normalized, frontMatter: false, sourceFields: [] };
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { fields, metadata, body: normalized, frontMatter: false, sourceFields: [] };
  const header = normalized.slice(4, end).split("\n");
  const afterHeader = normalized.slice(end + 4);
  const body = afterHeader.replace(/^[^\n]*\n/, "").replace(/^\n+/, "");
  const sourceNames = new Set<string>();
  let section: Record<string, string> | undefined;
  for (let i = 0; i < header.length; i++) {
    const line = header[i] as string;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const raw = (match[2] ?? "").trim();
    if (indent === 0 && (SKILL_SOURCE_FIELDS as readonly string[]).includes(key))
      sourceNames.add(key);
    if (indent === 0) section = undefined;
    else if (!section) continue;
    if (indent === 0 && !raw) {
      section = key === "metadata" ? metadata : {};
      continue;
    }
    const target = indent === 0 ? fields : section;
    if (!target) continue;
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const block: string[] = [];
      while (i + 1 < header.length) {
        const next = header[i + 1] as string;
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        block.push(next.trim());
        i++;
      }
      target[key] = raw.startsWith("|") ? block.join("\n").trim() : block.join(" ").trim();
      continue;
    }
    target[key] = scalar(raw);
  }
  const sourceFields = SKILL_SOURCE_FIELDS.filter((field) => sourceNames.has(field));
  return { fields, metadata, body, frontMatter: true, sourceFields };
}

function scalar(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "string") return value;
    } catch {
      // Not JSON-compatible YAML escaping; fall back to the literal text between the quotes.
    }
    return raw.slice(1, -1);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    return raw.slice(1, -1).replaceAll("''", "'");
  return raw.replace(/\s+#.*$/, "");
}

export const SkillFileParamsSchema = z.array(SkillParamSchema).max(20);
export function storedParams(parsed: ParsedSkillFile): SkillParam[] {
  const raw = parsed.metadata["pibot-params"];
  if (!raw) return [];
  try {
    return SkillFileParamsSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** `pibot-version` as a positive integer; undefined when absent or not a plain number. */
export function storedVersion(parsed: ParsedSkillFile): number | undefined {
  const raw = parsed.metadata["pibot-version"]?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return undefined;
  const version = SkillVersionSchema.safeParse(Number(raw));
  return version.success ? version.data : undefined;
}
/** Raw `pibot-contract` text (not validated here, see `skillContract`). */
export function storedContract(parsed: ParsedSkillFile): string | undefined {
  const raw = parsed.metadata["pibot-contract"]?.trim();
  return raw && raw.length <= SKILL_CONTRACT_MAX_CHARS ? raw : undefined;
}
/** The source's own version, written by Pi Bot on import; bounded so a later update check can compare it. */
export function storedSourceVersion(parsed: ParsedSkillFile): string | undefined {
  const raw = parsed.metadata["pibot-source-version"]?.trim();
  return raw && raw.length <= SKILL_SOURCE_VERSION_MAX_CHARS ? raw : undefined;
}
/** Raw verification text is retained; `skillContract` validates it without blocking load. */
export function storedVerified(parsed: ParsedSkillFile): string | undefined {
  const raw = parsed.metadata["pibot-verified"];
  return raw && raw.length <= SKILL_VERIFIED_MAX_CHARS ? raw : undefined;
}
/** Version and contract metadata of a parsed file, ready to spread into a document. */
export function storedWorkflow(
  parsed: ParsedSkillFile,
): Pick<
  SkillDocument,
  "version" | "sourceVersion" | "contract" | "verified" | "sourceFields" | "linkOrigin"
> {
  const version = storedVersion(parsed);
  const sourceVersion = storedSourceVersion(parsed);
  const contract = storedContract(parsed);
  const verified = storedVerified(parsed);
  const sourceFields = storedSourceFields(parsed);
  const linkOrigin = storedLinkOrigin(parsed);
  return {
    ...(sourceFields !== undefined ? { sourceFields } : {}),
    ...(linkOrigin !== undefined ? { linkOrigin } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(sourceVersion !== undefined ? { sourceVersion } : {}),
    ...(contract !== undefined ? { contract } : {}),
    ...(verified !== undefined ? { verified } : {}),
  };
}

function storedSourceFields(parsed: ParsedSkillFile): SkillDocument["sourceFields"] {
  const raw = parsed.metadata["pibot-source-fields"];
  if (raw && raw.length <= 1024) {
    try {
      const saved = SkillSourceFieldsSchema.safeParse(JSON.parse(raw));
      if (saved.success) return saved.data;
    } catch {
      // Advisory metadata is optional; malformed external values cannot block a skill load.
    }
  }
  return undefined;
}

/**
 * Display name of a parsed file: Agent Skills files keep it in `metadata.pibot-name` (`name` is
 * the folder slug); a hand-written file has only `name`, which is then the display name.
 */
export function storedName(parsed: ParsedSkillFile): string | undefined {
  return parsed.metadata["pibot-name"] ?? parsed.fields.name;
}

/** Builds the document for an imported file; throws when it has no usable name, description or body. */
export function importedDocument(parsed: ParsedSkillFile, fallbackName: string): SkillDocument {
  // External files cannot nominate a future update endpoint, including Pi Bot exports.
  const { linkOrigin: _untrustedOrigin, ...workflow } = storedWorkflow(parsed);
  // First import: keep the source's declared version instead of rewriting the file without it;
  // the update check has nothing else to compare against on the next update.
  const sourceVersion = workflow.sourceVersion ?? declaredSourceVersion(parsed);
  const input: SkillDocumentInput = {
    name: flat(storedName(parsed) ?? fallbackName).slice(0, 80),
    // Folded YAML descriptions span lines; the list and system prompt need one plain line.
    description: flat(parsed.fields.description ?? "").slice(0, 1024),
    body: parsed.body,
    params: storedParams(parsed),
    ...workflow,
    ...(sourceVersion !== undefined ? { sourceVersion } : {}),
  };
  return SkillDocumentSchema.parse(input);
}

/** Agent Skills declares it under `metadata.version`; hand-written files may use a top-level key. */
function declaredSourceVersion(parsed: ParsedSkillFile): string | undefined {
  const raw = flat(parsed.metadata.version ?? parsed.fields.version ?? "");
  return raw && raw.length <= SKILL_SOURCE_VERSION_MAX_CHARS ? raw : undefined;
}

function storedLinkOrigin(parsed: ParsedSkillFile): SkillDocument["linkOrigin"] {
  const raw = parsed.metadata["pibot-link-origin"];
  if (!raw || raw.length > 8192) return undefined;
  try {
    const result = SkillLinkOriginSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    // Untrusted advisory metadata never blocks loading an otherwise readable skill.
    return undefined;
  }
}
