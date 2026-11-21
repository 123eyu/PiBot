import { dirname, resolve } from "node:path";
import { CitationSectionNameSchema, type DeliveryItem } from "@pibot/protocol-base";
import { sourceDefinitions } from "./delivery-definitions.ts";

export { sourceDigest } from "./delivery-reference.ts";

import type { WorkspaceFileAccess } from "../../resources/workplaces/workspace-files.ts";
import { resolveReference } from "./delivery-reference.ts";

export interface DeliverySources {
  access?: WorkspaceFileAccess;
  webDigests: ReadonlySet<string>;
  files: readonly string[];
  folders: readonly string[];
  /** Resolution aliases only; these roots do not make unread files eligible sources. */
  workspaceRoots?: readonly string[];
  artifactRoots?: readonly string[];
  excludedFiles?: readonly string[];
  incomplete?: boolean;
}
export const emptySources = (): DeliverySources => ({
  webDigests: new Set(),
  files: [],
  folders: [],
});

export function markdownOutline(text: string) {
  let fence: string | undefined;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
      if (marker) {
        if (!fence) fence = marker[0];
        else if (fence === marker[0]) fence = undefined;
        return "";
      }
      return fence ? "" : raw;
    });
}
export const sectionKey = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s#>*_-]*(?:\d+[.)、]|[一二三四五六七八九十]+[、.])?\s*/u, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");

type SourceSection = NonNullable<DeliveryItem["citationContext"]>["section"] & string;
const SOURCE_SECTIONS: ReadonlySet<string> = new Set(CitationSectionNameSchema.options);

/** Resolve references against observed URLs and explicitly supplied local inputs only. */
export async function citationEvidence(
  text: string,
  folder: string,
  sources: DeliverySources,
  signal: AbortSignal,
  format: "md" | "docx" | "xlsx" | "pptx" = "md",
  sections: readonly string[] = [],
  documentPath?: string,
) {
  signal.throwIfAborted();
  const paths = sources.access?.paths;
  const documentFolder = documentPath
    ? (paths?.dirname ?? dirname)((paths?.resolve ?? resolve)(folder, documentPath))
    : folder;
  const aliases = {
    ...sources,
    artifactRoots: [...new Set([folder, ...(sources.artifactRoots ?? [])])],
  };
  const lines =
    format === "md" || format === "docx"
      ? markdownOutline(text)
      : text.replace(/\r\n?/g, "\n").split("\n");
  const styledDocx = format === "docx" && lines.some((line) => /^#{1,6}\s/.test(line));
  const headings = lines.flatMap((line, index) => {
    if (format === "xlsx") {
      const sheet = /^\[(.+)\]$/.exec(line.trim());
      return sheet?.[1] && (index === 0 || !lines[index - 1]?.trim())
        ? [{ line: index, level: 1, name: sheet[1] }]
        : [];
    }
    if (format === "pptx") {
      const slide = /^\[Slide \d+\]\s*(.*)$/.exec(line.trim());
      if (slide) return slide[1] ? [{ line: index, level: 1, name: slide[1] }] : [];
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (match?.[1] && match[2]) return [{ line: index, level: match[1].length, name: match[2] }];
    return format !== "md" && !styledDocx && line.trim() && Array.from(line.trim()).length <= 40
      ? [{ line: index, level: 1, name: line.trim() }]
      : [];
  });
  const sectionEnds = new Map<number, number>();
  const stack: typeof headings = [];
  for (const heading of headings) {
    while (stack.length && (stack.at(-1)?.level ?? 7) >= heading.level) {
      const previous = stack.pop();
      if (previous) sectionEnds.set(previous.line, heading.line);
    }
    stack.push(heading);
  }
  // Reports often discuss data sources earlier; only a complete section name is a bibliography.
  const declared = new Set(sections.map(sectionKey));
  const sourceWord = /来源|参考|sources?|references?/iu;
  const explanation = /说明|方法|口径|methodology|explanation|method|notes?/iu;
  const bibliography = /^(?:来源列表|来源清单|参考列表|参考清单|sources?list|references?list)$/u;
  const sourceParents: typeof headings = [];
  const candidates = headings.filter((h) => {
    while (sourceParents.length && (sourceParents.at(-1)?.level ?? 7) >= h.level)
      sourceParents.pop();
    const key = sectionKey(h.name);
    const sourceTitle = sourceWord.test(key) && !explanation.test(key);
    const declaredSource = declared.has(key) && sourceTitle;
    const underSource = sourceParents.length > 0;
    if (declaredSource) sourceParents.push(h);
    // A source-bearing child of a declared bibliography is narrower than an arbitrary mention.
    return (
      SOURCE_SECTIONS.has(key) ||
      (sourceTitle && (declaredSource || bibliography.test(key) || underSource))
    );
  });
  const sourceHeading = candidates.at(-1);
  const citationContext: NonNullable<DeliveryItem["citationContext"]> = {
    section: sourceHeading
      ? SOURCE_SECTIONS.has(sectionKey(sourceHeading.name))
        ? (sectionKey(sourceHeading.name) as SourceSection)
        : declared.has(sectionKey(sourceHeading.name))
          ? "contract"
          : "subheading"
      : null,
    ...(sourceHeading ? { line: sourceHeading.line + 1 } : {}),
    bases: [
      "document",
      "artifact",
      ...(sources.workspaceRoots?.length ? ["workspace" as const] : []),
    ],
  };
  const end = sourceHeading
    ? (headings.find(
        (h) =>
          h.line > sourceHeading.line &&
          (format === "md"
            ? h.level <= sourceHeading.level
            : sections.map(sectionKey).includes(sectionKey(h.name))),
      )?.line ?? lines.length)
    : lines.length;
  const sourceStart = sourceHeading?.line ?? lines.length;
  const definitions = sourceDefinitions(lines.slice(sourceStart + 1, end), signal);
  const cache = new Map<string, ReturnType<typeof resolveReference>>();
  const resolves = (value: string) => {
    let pending = cache.get(value);
    if (!pending) {
      pending = resolveReference(value, documentFolder, aliases, signal);
      cache.set(value, pending);
    }
    return pending;
  };
  const resolved = new Map<string, string>();
  const failures = new Map<string, "missing_file" | "not_read" | "invalid_format">();
  for (const [key, values] of definitions) {
    for (const value of values) {
      const result = await resolves(value);
      if (result.ok) {
        resolved.set(key, result.source);
        break;
      }
      failures.set(key, result.reason);
    }
  }
  const used = new Set<string>();
  const resolvedUsed = new Set<string>();
  const distinctSources = new Set<string>();
  const body = lines.map((line, index) => (index >= sourceStart && index < end ? "" : line));
  const cited = async (value: string) => {
    value = value.replace(/`[^`]*`/g, "");
    let valid = false;
    // Numeric link labels are resolved by their destination, not a second numbered definition.
    for (const match of value.matchAll(/(?<!!)\[\^?(\d{1,4})\](?!\()/gu)) {
      const key = match[1] ?? "";
      used.add(key);
      const source = resolved.get(key);
      if (source) {
        resolvedUsed.add(key);
        distinctSources.add(source);
        valid = true;
      }
    }
    for (const match of value.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)]+)\)/g)) {
      if (used.size >= 200) break;
      const target = match[1] ?? "";
      used.add(target);
      const result = await resolves(target);
      const source = result.ok ? result.source : undefined;
      if (!result.ok) failures.set(target, result.reason);
      if (source) {
        resolvedUsed.add(target);
        distinctSources.add(source);
        valid = true;
      }
    }
    return valid;
  };
  await cited(body.join("\n"));
  const sourced = new Set<string>();
  for (const heading of headings) {
    if (heading.line >= sourceStart && heading.line < end) {
      // The Sources list is itself supported only when at least one entry resolves.
      if (resolved.size) sourced.add(sectionKey(heading.name));
      continue;
    }
    const next = sectionEnds.get(heading.line) ?? lines.length;
    const key = sectionKey(heading.name);
    if (
      sourceHeading &&
      resolved.size &&
      heading.line < sourceStart &&
      next > sourceStart &&
      declared.has(key) &&
      sourceWord.test(key) &&
      !explanation.test(key)
    )
      sourced.add(sectionKey(heading.name));
    if (await cited(body.slice(heading.line + 1, next).join("\n")))
      sourced.add(sectionKey(heading.name));
  }
  return {
    citationContext,
    referenceIssues: (sourceHeading ? [...used] : [])
      .filter((key) => !resolvedUsed.has(key))
      .slice(0, 10)
      .map((key) => ({
        label: /^\d+$/.test(key) ? `[${key}]` : "unresolved_link",
        reason: failures.get(key) ?? "invalid_format",
      })),
    hasSources: !!sourceHeading,
    count: distinctSources.size,
    sourced,
    unresolved: [...used]
      .filter((key) => !resolvedUsed.has(key))
      .map((key) => (/^\d+$/.test(key) ? `[${key}]` : "unresolved_link")),
  };
}
