import type { SemanticFileCache } from "@pibot/execution/semantic";
import type { ToolRunContext } from "../../core/local-types.ts";

/**
 * Snapshot bytes live for one run, never in a module singleton. Root and capture scope key
 * the map so a narrowed diagnostics scan and a whole-project navigation do not share a snapshot
 * by accident; file stats still decide whether a cached text is current.
 */
export function semanticFileCache(
  context: ToolRunContext,
  root: string,
  scope = "",
): SemanticFileCache {
  context.semanticFileCaches ??= new Map();
  const key = `${root}\0${scope}`;
  const existing = context.semanticFileCaches.get(key);
  if (existing) return existing;
  const cache: SemanticFileCache = { files: new Map(), bytes: 0 };
  context.semanticFileCaches.set(key, cache);
  return cache;
}
