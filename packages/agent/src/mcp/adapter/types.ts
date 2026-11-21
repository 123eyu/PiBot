// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: server entries keep only the tool-selection fields; transport and credentials are resolved by Pi Bot.
// Upstream file: types.ts
// types.ts - Core type definitions

import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ListToolsResult, Transport as McpTransport } from "@modelcontextprotocol/client";

export type Transport = McpTransport;

type SdkTool = ListToolsResult["tools"][number];

// MCP wire definitions derive their field types from the installed SDK while
// retaining the adapter's deliberately smaller public surface.
export interface McpTool {
  name: SdkTool["name"];
  title?: SdkTool["title"];
  description?: SdkTool["description"];
  inputSchema?: SdkTool["inputSchema"]; // JSON Schema
  outputSchema?: SdkTool["outputSchema"]; // JSON Schema for structuredContent
  annotations?: SdkTool["annotations"];
  _meta?: SdkTool["_meta"];
}

// Content types from MCP
export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// Server configuration. Pi Bot resolves transport and credentials in brain;
// the derived runtime only consumes the tool-selection surface (the other upstream fields
// were trimmed).
export interface ServerEntry {
  /** Short human summary shown by the connector catalog and ranked by discovery search. */
  description?: string;
  // Override settings.toolPrefix for this server.
  toolPrefix?: ToolPrefix;
  // Include/exclude specific MCP tools by original or prefixed name
  includeTools?: string[];
  excludeTools?: string[];
  /**
   * Extra search keywords per tool, keyed by original name, prefixed name, or
   * glob (same matching rules as includeTools/excludeTools). Keywords boost
   * discovery ranking only — they never appear in tool schemas,
   * describe output, or the metadata cache.
   */
  searchKeywords?: Record<string, string[]>;
  // Keep configuration visible without allowing connections or execution.
  disabled?: boolean;
}

/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition: ServerEntry | undefined): boolean {
  return definition?.disabled === true;
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
  /** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
  maxBytes?: number;
  /** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
  maxLines?: number;
  /** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
  detailsMaxBytes?: number;
}

// Settings
export type ToolPrefix = "server" | "none" | "short" | "mcp";

const ENCODED_SERVER_NAMESPACE_MARKER = "_mcpns_";
// Provider tool-name limit (64 for Bedrock, Anthropic, OpenAI) minus the `mcp__` proxy prefix.
const MAX_SERVER_NAMESPACE_LENGTH = 59;

export function formatServerNamespace(serverName: string): string {
  const normalized = serverName.replace(/-/g, "_");
  const safe =
    /^[A-Za-z0-9_]*$/.test(normalized) && !normalized.startsWith(ENCODED_SERVER_NAMESPACE_MARKER);
  const body = safe ? normalized : encodeServerNamespace(normalized);
  const namespace = safe ? body : `${ENCODED_SERVER_NAMESPACE_MARKER}${body}`;
  if (namespace.length <= MAX_SERVER_NAMESPACE_LENGTH) return namespace;
  // Hash the ASCII encoding, not the raw name: lone surrogates and U+FFFD share UTF-8 bytes.
  const digest = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 16);
  // `_h_` cannot start an encoded body: `h` is neither `_` nor a hexadecimal digit.
  const hashPrefix = `${ENCODED_SERVER_NAMESPACE_MARKER}_h_`;
  const head = body.slice(0, MAX_SERVER_NAMESPACE_LENGTH - hashPrefix.length - digest.length - 1);
  return `${hashPrefix}${head}_${digest}`;
}

// `_` becomes `__`, so `__` and `_<hex>_` form a prefix code and the encoding stays injective.
function encodeServerNamespace(name: string): string {
  return Array.from(name, (character) => {
    if (character === "_") return "__";
    return /^[A-Za-z0-9]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16)}_`;
  }).join("");
}
// Settings: Pi Bot keeps only what the derived runtime consumes
// (tool prefix, call timeout, output guard); everything TUI/config-scoped is cut.
export interface McpSettings {
  toolPrefix?: ToolPrefix;
  requestTimeoutMs?: number; // milliseconds, overrides the SDK request timeout when > 0
  /**
   * Guard oversized MCP tool output before it is returned to the model.
   * Defaults to true (50 KiB / 2,000 lines inline text, 16 KiB details.mcpResult).
   * Set to false to restore raw MCP output behavior, or pass an object to tune
   * the limits.
   */
  outputGuard?: boolean | McpOutputGuardSettings;
}

export interface ToolMetadata {
  name: string; // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string; // Original MCP tool name (e.g., "list_sims")
  description: string;
  inputSchema?: unknown; // JSON Schema for parameters (stored for describe/errors)
  outputSchema?: unknown; // Server schema for structuredContent (stored for describe)
  annotations?: McpToolAnnotations;
}

/** Behavior hints a server declared on a tool. Hints, not guarantees. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Get server prefix based on tool prefix mode.
 */
function sanitizeServerPrefix(serverName: string, preserveProviderValid = true): string {
  const validCharacters = preserveProviderValid ? /^[A-Za-z0-9_-]$/ : /^[A-Za-z0-9]$/;
  return Array.from(serverName, (char) =>
    validCharacters.test(char) ? char : `_${char.codePointAt(0)?.toString(16)}_`,
  ).join("");
}

export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""));
    if (!short) short = "mcp";
    return short;
  }
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName)}`;
  return sanitizeServerPrefix(serverName);
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const p = getServerPrefix(serverName, prefix);
  const sanitized = toolName.replace(/\./g, "_");
  if (p && sanitized.startsWith(`${p}_`) && sanitized.length > p.length + 1) {
    return sanitized;
  }
  return p ? `${p}_${sanitized}` : sanitized;
}

export function resolveToolPrefix(
  definition?: Pick<ServerEntry, "toolPrefix">,
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? "server";
}

/** A canonical name has an owner only when exactly one eligible entry produces it. */
export function resolveUniqueNameOwnership<T>(
  entries: readonly T[],
  getName: (entry: T) => string,
): { unique: T[]; collisions: Map<string, T[]> } {
  const owners = new Map<string, T[]>();
  for (const entry of entries) {
    const name = getName(entry);
    const named = owners.get(name) ?? [];
    named.push(entry);
    owners.set(name, named);
  }
  const collisions = new Map([...owners].filter(([, named]) => named.length > 1));
  return {
    unique: entries.filter((entry) => !collisions.has(getName(entry))),
    collisions,
  };
}

/**
 * Resolve a configured MCP server name from a prefixed tool name.
 *
 * When the proxy tool is addressed with a fully-qualified name such as
 * `searxng_searxng_web_search`, downstream policy systems (for example a
 * permission gate) need to recover the owning server so they can evaluate
 * server-scoped rules against the bare server name. This performs the inverse
 * of {@link getServerPrefix}: it finds the longest configured server prefix
 * that the tool name starts with and returns that server's name.
 *
 * @param toolName - the tool name as passed to the proxy `mcp({ tool })` call.
 * @param serverNames - the configured MCP server names (keys of `mcpServers`).
 * @param prefix - the active tool-prefix mode.
 * @returns the resolved server name, or `undefined` when no prefix matches or
 *   the prefix mode is `"none"`.
 */
export function resolveServerFromToolName(
  toolName: string,
  serverNames: Iterable<string>,
  prefix: ToolPrefix,
): string | undefined {
  if (prefix === "none") return undefined;
  const candidates: { name: string; prefix: string }[] = [];
  for (const name of serverNames) {
    const p = getServerPrefix(name, prefix);
    if (p && toolName.startsWith(`${p}_`)) candidates.push({ name, prefix: p });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);
  const best = candidates[0];
  // Fail safe: short mode can intentionally map names such as foo and foo-mcp
  // to the same prefix. Return undefined so a downstream permission gate uses
  // its existing wildcard path rather than enforcing a rule against the wrong server.
  if (candidates.some((c) => c.prefix === best?.prefix && c.name !== best?.name)) {
    return undefined;
  }
  return best?.name;
}

function getLegacyServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short")
    return sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""), false) || "mcp";
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName, false)}`;
  return sanitizeServerPrefix(serverName, false);
}

function formatLegacyToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const serverPrefix = getLegacyServerPrefix(serverName, prefix);
  const sanitizedToolName = toolName.replace(/[.-]/g, "_");
  return serverPrefix ? `${serverPrefix}_${sanitizedToolName}` : sanitizedToolName;
}

export function getToolNameCandidates(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeLegacy = true,
): Set<string> {
  const candidates = new Set<string>([
    toolName,
    formatToolName(toolName, serverName, prefix),
    formatToolName(toolName, serverName, "server"),
    formatToolName(toolName, serverName, "short"),
    formatToolName(toolName, serverName, "mcp"),
  ]);
  if (includeLegacy) {
    const legacyToolName = toolName.replace(/-/g, "_");
    candidates.add(legacyToolName);
    candidates.add(formatToolName(legacyToolName, serverName, prefix));
    candidates.add(formatToolName(legacyToolName, serverName, "server"));
    candidates.add(formatToolName(legacyToolName, serverName, "short"));
    candidates.add(formatToolName(legacyToolName, serverName, "mcp"));
    candidates.add(formatLegacyToolName(toolName, serverName, prefix));
    candidates.add(formatLegacyToolName(toolName, serverName, "server"));
    candidates.add(formatLegacyToolName(toolName, serverName, "short"));
    candidates.add(formatLegacyToolName(toolName, serverName, "mcp"));
    candidates.add(formatToolName(toolName, serverName, prefix).replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "server").replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "short").replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "mcp").replace(/-/g, "_"));
  }
  return candidates;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export interface ToolSelectorCandidateIndex {
  readonly allCurrentCandidates: ReadonlySet<string>;
  readonly matchingCountByPattern: Map<string, number>;
  readonly matcherByPattern: Map<string, RegExp>;
  readonly additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function createToolSelectorCandidateIndex(
  allCurrentCandidates: Set<string>,
  additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>,
): ToolSelectorCandidateIndex {
  return {
    allCurrentCandidates,
    matchingCountByPattern: new Map<string, number>(),
    matcherByPattern: new Map<string, RegExp>(),
    ...(additionalCurrentCandidatesByToolName ? { additionalCurrentCandidatesByToolName } : {}),
  };
}

export function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (!pattern.includes("*") && !pattern.includes("?") && candidates.has(pattern)) {
      return true;
    }
    if (
      (pattern.includes("*") || pattern.includes("?")) &&
      [...candidates].some((candidate) => globToRegExp(pattern).test(candidate))
    ) {
      return true;
    }
  }

  return false;
}

export type ToolSelectorCandidateContext = Set<string> | ToolSelectorCandidateIndex;

function indexHasOtherCurrentMatch(
  index: ToolSelectorCandidateIndex,
  toolName: string,
  currentCandidates: Set<string>,
  pattern: string,
): boolean {
  const additionalCandidates = index.additionalCurrentCandidatesByToolName?.get(toolName);
  const hasCandidate = (candidate: string): boolean =>
    index.allCurrentCandidates.has(candidate) || additionalCandidates?.has(candidate) === true;
  const isGlob = pattern.includes("*") || pattern.includes("?");
  if (!isGlob) {
    return hasCandidate(pattern) && !currentCandidates.has(pattern);
  }

  let matcher = index.matcherByPattern.get(pattern);
  if (!matcher) {
    matcher = globToRegExp(pattern);
    index.matcherByPattern.set(pattern, matcher);
  }
  let matchingCount = index.matchingCountByPattern.get(pattern);
  if (matchingCount === undefined) {
    matchingCount = 0;
    for (const candidate of index.allCurrentCandidates) {
      if (matcher.test(candidate)) matchingCount++;
    }
    index.matchingCountByPattern.set(pattern, matchingCount);
  }

  let totalMatchingCount = matchingCount;
  if (additionalCandidates) {
    for (const candidate of additionalCandidates) {
      if (!index.allCurrentCandidates.has(candidate) && matcher.test(candidate))
        totalMatchingCount++;
    }
  }
  if (totalMatchingCount === 0) return false;

  let currentMatchingCount = 0;
  for (const candidate of currentCandidates) {
    if (hasCandidate(candidate) && matcher.test(candidate)) currentMatchingCount++;
  }
  return totalMatchingCount > currentMatchingCount;
}

function matchesToolSelector(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  patterns: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const currentCandidates = getToolNameCandidates(toolName, serverName, prefix, false);
  if (matchesToolPattern(currentCandidates, patterns)) return true;
  if (!otherCurrentCandidates)
    return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), patterns);
  const legacyCandidates = getToolNameCandidates(toolName, serverName, prefix);
  for (const candidate of currentCandidates) legacyCandidates.delete(candidate);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || !matchesToolPattern(legacyCandidates, [pattern]))
      return false;
    const hasCollision =
      otherCurrentCandidates instanceof Set
        ? matchesToolPattern(otherCurrentCandidates, [pattern])
        : indexHasOtherCurrentMatch(otherCurrentCandidates, toolName, currentCandidates, pattern);
    return !hasCollision;
  });
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
  return matchesToolSelector(toolName, serverName, prefix, includeTools, otherCurrentCandidates);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return matchesToolSelector(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}

export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return (
    isToolIncluded(toolName, serverName, prefix, includeTools, otherCurrentCandidates) &&
    !isToolExcluded(toolName, serverName, prefix, excludeTools, otherCurrentCandidates)
  );
}
