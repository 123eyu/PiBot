// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: host temp directories, global caches and environment switches removed; files and redaction go through Pi Bot ports.
// Upstream file: search-ranking.ts
import type { ServerEntry, ToolMetadata, ToolPrefix } from "./types.ts";
import { getToolNameCandidates, matchesToolPattern, resolveToolPrefix } from "./types.ts";

// Cut: state-backed ranking (rankToolMatches/rankSuggestions/getPreparedTools and the
// per-state cache). The Pi Bot connection ranks one connection's catalog with scoreToolMatch.

/**
 * Shortest field token allowed to stem-match a longer query token.
 * Real descriptions tokenize possessives into single letters ("project's" -> ["project", "s"]),
 * which would otherwise make every query starting with that letter a match.
 */
const MIN_STEM_LENGTH = 4;

// Keep ASCII tokens unchanged; bound adjacent bigrams for non-ASCII Unicode word runs.
// Whole-run fallbacks preserve single characters and prevent truncated queries from matching only a prefix.
const MAX_UNICODE_BIGRAMS_PER_RUN = 64;
const SEARCH_RUN = /[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}\p{M}])+/gu;
const ASCII_RUN = /^[a-z0-9]+$/;

const FIELD_WEIGHTS = {
  name: 12,
  originalName: 10,
  server: 8,
  description: 5,
  serverDescription: 5,
  keywords: 5,
} as const;

type SearchField = Exclude<keyof typeof FIELD_WEIGHTS, "keywords">;

interface PreparedToolSearch {
  tool: ToolMetadata;
  fields: Array<[SearchField, string, string[]]>;
  nameTokens: string[];
  keywordPhrases: string[];
  keywordTokens: string[];
}

/**
 * Resolve the configured searchKeywords entries that apply to a tool.
 * Keys match by original name, prefixed name, or glob — the same candidate
 * set includeTools/excludeTools use — and all matching entries are unioned.
 */
export function resolveSearchKeywords(
  definition: ServerEntry | undefined,
  toolOriginalName: string,
  serverName: string,
  globalPrefix: ToolPrefix,
): string[] {
  const map = definition?.searchKeywords;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const candidates = getToolNameCandidates(
    toolOriginalName,
    serverName,
    resolveToolPrefix(definition, globalPrefix),
  );
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const [pattern, values] of Object.entries(map)) {
    if (!Array.isArray(values)) continue;
    if (!matchesToolPattern(candidates, [pattern])) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      keywords.push(trimmed);
    }
  }
  return keywords;
}

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const run of normalizeSearchText(value).match(SEARCH_RUN) ?? []) {
    if (ASCII_RUN.test(run)) {
      tokens.push(run);
      continue;
    }
    const characters = [...run];
    if (characters.length === 1 || characters.length > MAX_UNICODE_BIGRAMS_PER_RUN + 1) {
      tokens.push(run);
      continue;
    }
    let previous = "";
    for (const character of characters) {
      if (previous) {
        tokens.push(previous + character);
      }
      previous = character;
    }
  }
  return [...new Set(tokens)];
}

function matchesAsciiStem(fieldToken: string, queryToken: string): boolean {
  return (
    ASCII_RUN.test(fieldToken) &&
    ASCII_RUN.test(queryToken) &&
    (fieldToken.startsWith(queryToken) ||
      (fieldToken.length >= MIN_STEM_LENGTH && queryToken.startsWith(fieldToken)))
  );
}

function prepareToolSearch(
  tool: ToolMetadata,
  server: string,
  keywords?: string[],
  serverDescription?: string,
): PreparedToolSearch {
  const fields = {
    name: normalizeSearchText(tool.name),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(server),
    description: normalizeSearchText(tool.description),
    serverDescription: normalizeSearchText(serverDescription ?? ""),
  };
  const preparedFields = (Object.entries(fields) as Array<[SearchField, string]>).map(
    ([field, value]): [SearchField, string, string[]] => [field, value, tokenize(value)],
  );
  const keywordPhrases =
    keywords?.map((keyword) => normalizeSearchText(keyword).trim()).filter(Boolean) ?? [];
  return {
    tool,
    fields: preparedFields,
    nameTokens: preparedFields[0]?.[2] ?? [],
    keywordPhrases,
    keywordTokens: keywordPhrases.flatMap(tokenize),
  };
}

function scorePreparedToolMatch(
  prepared: PreparedToolSearch,
  normalizedQuery: string,
  queryTokens: string[],
): number | null {
  let score = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, value, fieldTokens] of prepared.fields) {
    const weight = FIELD_WEIGHTS[field];
    if (value === normalizedQuery) {
      score += weight * 14;
      phraseMatched = true;
      wholeFieldExact = true;
    } else if (value.startsWith(normalizedQuery)) {
      score += weight * 9;
      phraseMatched = true;
    } else if (value.includes(normalizedQuery)) {
      score += weight * 6;
      phraseMatched = true;
    }

    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        score += weight * 4;
        matchedTokens.add(token);
      } else if (fieldTokens.some((fieldToken) => matchesAsciiStem(fieldToken, token))) {
        score += weight * 2;
        matchedTokens.add(token);
      } else if (value.includes(token)) {
        score += weight;
        matchedTokens.add(token);
      }
    }
  }

  // Configured keywords are discrete phrases, so the phrase-level bonus is
  // computed per phrase (best match wins) rather than on a joined string,
  // which would phrase-match queries spanning two unrelated keywords.
  if (prepared.keywordPhrases.length > 0) {
    const weight = FIELD_WEIGHTS.keywords;
    let phraseScore = 0;
    for (const phrase of prepared.keywordPhrases) {
      if (phrase === normalizedQuery) {
        phraseScore = Math.max(phraseScore, weight * 14);
        phraseMatched = true;
        wholeFieldExact = true;
      } else if (phrase.startsWith(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 9);
        phraseMatched = true;
      } else if (phrase.includes(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 6);
        phraseMatched = true;
      }
    }
    score += phraseScore;

    for (const token of queryTokens) {
      if (prepared.keywordTokens.includes(token)) {
        score += weight * 4;
        matchedTokens.add(token);
      } else if (
        prepared.keywordTokens.some((keywordToken) => matchesAsciiStem(keywordToken, token))
      ) {
        score += weight * 2;
        matchedTokens.add(token);
      } else if (prepared.keywordPhrases.some((phrase) => phrase.includes(token))) {
        score += weight;
        matchedTokens.add(token);
      }
    }
  }

  const coverage = matchedTokens.size / queryTokens.length;
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null;

  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  const firstQueryToken = queryTokens[0];
  if (firstQueryToken !== undefined && prepared.nameTokens.includes(firstQueryToken)) score += 8;
  if (wholeFieldExact) score += 20;
  return score;
}

export function scoreToolMatch(
  tool: ToolMetadata,
  server: string,
  query: string,
  keywords?: string[],
): number | null {
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;
  return scorePreparedToolMatch(
    prepareToolSearch(tool, server, keywords),
    normalizedQuery,
    queryTokens,
  );
}

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const total = items.length;
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length;
  return {
    items: page,
    total,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
