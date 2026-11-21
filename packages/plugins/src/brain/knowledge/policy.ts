/*
 * The prepare phase of a knowledge call: every Notion library behind the call is judged as the
 * connection call it is before the tool runs, and the ids that were judged travel back to the
 * executor (KB-11).
 */
import type { ToolRunContext } from "@pibot/brain/kit";
import { connectorCallRequest, type PolicyRequest } from "@pibot/policy";
import type { KnowledgePrepared } from "./access.ts";
import { type KnowledgeToolDeps, selectSources } from "./common.ts";
import { READ_TOOLS, SEARCH_TOOLS } from "./notion.ts";

/**
 * A Notion library is somebody else's account, so each source behind a knowledge call is
 * judged as the connection call it is, in the prepare phase, before the tool runs: its own
 * confirmation mode (including "ask every time"), approval and audit stay the ordinary ones. The
 * strictest decision covers the call; sources nobody approved are named in the result instead of
 * failing the whole search. Obsidian has no request here because a folder is judged by the file
 * permission inside the executor.
 */
export function knowledgePolicyRequests(
  deps: Pick<KnowledgeToolDeps, "repo" | "connectors" | "service">,
  context: ToolRunContext,
  _call: { id: string },
  tool: string,
  input: Record<string, unknown>,
): { requests: PolicyRequest[]; prepared?: KnowledgePrepared } {
  if (tool !== "knowledge_search" && tool !== "knowledge_read") return { requests: [] };
  const selector = typeof input.source === "string" ? input.source : undefined;
  const candidates = tool === "knowledge_read" ? READ_TOOLS : SEARCH_TOOLS;
  const seen = new Set<string>();
  const judged: string[] = [];
  const requests: PolicyRequest[] = [];
  for (const entry of selectSources(deps.repo, context, selector)) {
    if (entry.config.kind !== "notion" || seen.has(entry.config.connectorId)) continue;
    const connectorId = entry.config.connectorId;
    seen.add(connectorId);
    const connector = deps.connectors.get(connectorId);
    // A missing connection needs no judgement: the executor reports it without any remote access.
    if (!connector) continue;
    const available = deps.service.discoverToolsForBot(
      context.botId,
      { connectorId, limit: 100 },
      true,
      context.groupId,
    ).items;
    for (const name of candidates) {
      const found = available.find((item) => item.tool === name && item.readOnly);
      if (!found) continue;
      requests.push(
        connectorCallRequest({
          connector,
          access: deps.connectors.access(connectorId),
          tool: found,
        }),
      );
      judged.push(connectorId);
      break;
    }
  }
  return { requests, prepared: { judged } };
}
