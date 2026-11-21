/*
 * The two knowledge tools. Each call reads what the person assigned to this Bot or group
 * right now, merges every library into one answer, and reports a failing library inside the result
 * instead of failing the whole search: a Bot whose Notion connection expired can still quote the
 * vault.
 *
 * Reaching a library (vault permission, connector channel) lives in `access.ts`; the prepare-phase
 * policy requests live in `policy.ts`.
 */
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/kit";
import {
  type KnowledgeConfig,
  KnowledgeReadInputSchema,
  KnowledgeSearchInputSchema,
  type KnowledgeSource,
  RpcError,
} from "@pibot/plugins-contract/full";
import { auditVaultRead, notionAccess, vaultAccess } from "./access.ts";
import {
  type CallAuthorization,
  CHANGED,
  DEFAULT_LIMIT,
  type Failure,
  type Item,
  type KnowledgeToolContext,
  type KnowledgeToolDeps,
  knowledgeCode,
  log,
  markUntrusted,
  noSourceText,
  selectSources,
  text,
  UNTRUSTED,
} from "./common.ts";
import { readNotion, searchNotion } from "./notion.ts";
import { obsidianVault, openUrl, readNote, searchVault } from "./obsidian.ts";

export type { KnowledgeToolContext, KnowledgeToolDeps } from "./common.ts";

export function registerKnowledgeTools(ctx: KnowledgeToolContext, deps: KnowledgeToolDeps): void {
  ctx.executor("knowledge_search", (context, call, signal, authorization) =>
    searchKnowledge(ctx, deps, context, call, signal, authorization),
  );
  ctx.executor("knowledge_read", (context, call, signal, authorization) =>
    readKnowledge(ctx, deps, context, call, signal, authorization),
  );
}

async function searchKnowledge(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization: CallAuthorization | undefined,
): Promise<LocalToolResult> {
  const input = KnowledgeSearchInputSchema.parse(call.input);
  const assigned = selectSources(deps.repo, context, input.source);
  if (assigned.length === 0)
    return {
      text: noSourceText(deps.repo, context, input.source),
      isError: true,
      details: { errorCode: "knowledge_source_unavailable" },
    };
  const limit = input.limit ?? DEFAULT_LIMIT;
  const items: Item[] = [];
  const failures: Failure[] = [];
  const read: string[] = [];
  for (const entry of assigned) {
    signal.throwIfAborted();
    if (items.length >= limit) break;
    try {
      const hits = await searchSource(
        ctx,
        deps,
        context,
        call,
        authorization,
        entry,
        input.query,
        signal,
        limit - items.length,
      );
      items.push(...hits);
      read.push(entry.source.id);
    } catch (error) {
      // A cancelled run is not a failing library: keep the cancellation, not a "source failed".
      signal.throwIfAborted();
      const code = knowledgeCode(error);
      failures.push({
        source: entry.source.name,
        sourceId: entry.source.id,
        code,
        ...(code === "knowledge_source_changed" ? { message: CHANGED } : {}),
      });
    }
  }
  if (read.length > 0) deps.repo.markUsed(read);
  // Nothing answered: that is a failed call, and the reasons are the useful part.
  if (items.length === 0 && failures.length > 0)
    return {
      text: text([
        UNTRUSTED,
        JSON.stringify({
          query: input.query,
          items: [],
          errors: failures,
        }),
      ]),
      isError: true,
      details: { errorCode: "knowledge_sources_failed" },
    };
  markUntrusted(context);
  log(ctx, "knowledge_search", {
    botId: context.botId,
    groupId: context.groupId,
    sources: assigned.length,
    hits: items.length,
    failures: failures.length,
  });
  return {
    text: text([
      UNTRUSTED,
      JSON.stringify({
        query: input.query,
        items,
        ...(failures.length ? { errors: failures } : {}),
        ...(items.length >= limit ? { truncated: "results" as const } : {}),
      }),
    ]),
    details: {
      resultCount: items.length,
      ...(failures.length ? { errorCode: "knowledge_partial_failure" } : {}),
    },
  };
}

async function readKnowledge(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization: CallAuthorization | undefined,
): Promise<LocalToolResult> {
  const input = KnowledgeReadInputSchema.parse(call.input);
  const assigned = selectSources(deps.repo, context, input.source);
  if (assigned.length === 0)
    return {
      text: noSourceText(deps.repo, context, input.source),
      isError: true,
      details: { errorCode: "knowledge_source_unavailable" },
    };
  // A read is about one document: two libraries with the same name would silently pick one.
  if (assigned.length > 1)
    return {
      text: `知识库名称不唯一，请用 id 指定 / Ambiguous source; pass the id: ${assigned
        .map((entry) => `${entry.source.name} (${entry.source.id})`)
        .join(", ")}`,
      isError: true,
      details: { errorCode: "knowledge_source_ambiguous" },
    };
  const entry = assigned[0] as (typeof assigned)[number];
  let page: Awaited<ReturnType<typeof readObsidian>>;
  try {
    page =
      entry.config.kind === "obsidian"
        ? await readObsidian(ctx, context, entry, input.ref, signal)
        : await readNotionPage(
            ctx,
            deps,
            context,
            call,
            authorization,
            entry.config,
            input.ref,
            signal,
          );
  } catch (error) {
    signal.throwIfAborted();
    if (knowledgeCode(error) !== "knowledge_source_changed") throw error;
    return { text: CHANGED, isError: true, details: { errorCode: "knowledge_source_changed" } };
  }
  deps.repo.markUsed([entry.source.id]);
  markUntrusted(context);
  log(ctx, "knowledge_read", {
    botId: context.botId,
    groupId: context.groupId,
    sourceId: entry.source.id,
    kind: entry.source.kind,
    truncated: page.truncated,
  });
  return {
    details: { resultCount: 1 },
    text: text([
      UNTRUSTED,
      JSON.stringify({
        source: entry.source.name,
        kind: entry.source.kind,
        ref: page.ref,
        title: page.title,
        ...(page.url ? { url: page.url } : {}),
        truncated: page.truncated,
        text: page.text,
      }),
    ]),
  };
}

async function searchSource(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  authorization: CallAuthorization | undefined,
  entry: { source: KnowledgeSource; config: KnowledgeConfig },
  query: string,
  signal: AbortSignal,
  limit: number,
): Promise<Item[]> {
  const base = { source: entry.source.name, sourceId: entry.source.id };
  if (entry.config.kind === "obsidian") {
    const found = await searchVault(
      obsidianVault(entry.config),
      query,
      await vaultAccess(ctx, context, signal),
    );
    auditVaultRead(ctx, context, entry, "knowledge_search", found.hits.length);
    return found.hits.slice(0, limit).map((hit) => ({
      ...base,
      kind: "obsidian" as const,
      title: hit.title,
      ref: hit.path,
      url: hit.url,
      line: hit.line,
      snippet: hit.snippet,
    }));
  }
  const found = await searchNotion(
    query,
    notionAccess(ctx, deps, context, call, authorization, entry.config, signal),
  );
  return found.hits.slice(0, limit).map((hit) => ({
    ...base,
    kind: "notion" as const,
    title: hit.title,
    ref: hit.ref,
    url: hit.url,
    snippet: hit.snippet,
  }));
}

async function readObsidian(
  ctx: KnowledgeToolContext,
  context: ToolRunContext,
  entry: { source: KnowledgeSource; config: KnowledgeConfig },
  ref: string,
  signal: AbortSignal,
) {
  const config = entry.config;
  if (config.kind !== "obsidian") throw new RpcError(-32602, "knowledge_source_missing");
  const note = await readNote(obsidianVault(config), ref, await vaultAccess(ctx, context, signal));
  auditVaultRead(ctx, context, entry, "knowledge_read", 1);
  return {
    ref: note.path,
    title: note.title,
    url: openUrl(config.path, note.path),
    text: note.text,
    truncated: note.truncated,
  };
}

async function readNotionPage(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  authorization: CallAuthorization | undefined,
  config: KnowledgeConfig,
  ref: string,
  signal: AbortSignal,
) {
  if (config.kind !== "notion") throw new RpcError(-32602, "knowledge_source_missing");
  const page = await readNotion(
    ref,
    notionAccess(ctx, deps, context, call, authorization, config, signal),
  );
  return {
    ref: page.ref,
    title: page.title,
    url: page.url,
    text: page.text,
    truncated: page.truncated,
  };
}
