import {
  type ConnectorManifest,
  type ConnectorTool,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { z } from "zod";

// A Notion workspace is reached through the person's own remote MCP connection, never
// through a Notion token Pi Bot keeps. Search and read therefore go through the connector call
// channel, where access, tool policy, confirmation mode and the OAuth credential are all decided;
// this module only picks the two tools by name and folds their answers into the same entry shape
// Obsidian returns, so the knowledge tools can merge both kinds without branching.

const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
/** The connector's network gate matches hosts, so it is the URL's host and nothing broader. */
const NOTION_DOMAIN = "mcp.notion.com";
const MAX_SNIPPET_CHARS = 300;
// A read is one page of knowledge, not a document dump: past this the answer stops being useful
// context and starts costing the whole run's budget.
const MAX_PAGE_CHARS = 60_000;

/**
 * Notion's hosted MCP server names its tools `search` and `fetch`; self-hosted servers in the wild
 * expose the API operation names. Both are accepted so a connection the person imported themselves
 * keeps working, and anything else fails closed instead of guessing which tool might be a search.
 */
export const SEARCH_TOOLS = ["search", "notion_search", "API-post-search"];
export const READ_TOOLS = ["fetch", "notion_fetch", "API-retrieve-a-page"];

/** Notion's hosted MCP tool that answers the bot user and the workspace it is connected to. */
export const ACCOUNT_TOOL = "notion-get-self";

export interface NotionAccountText {
  workspace: string | null;
  name: string | null;
  email: string | null;
}

const Text = z.string().trim().min(1).max(200);
const Email = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+$/);

/**
 * The account display text inside a `notion-get-self` answer. The answer's exact shape is
 * Notion's to change (API `users/me`: `bot.workspace_name`, `bot.owner.user.name/person.email`;
 * the MCP server may wrap or rename it), so the tree is searched for the few known keys with a
 * bound on depth and size instead of trusting one shape. The bot's own name is never taken as the
 * owner: a name counts only beside an email or inside an owner/person object. Ids and tokens are
 * not read at all.
 */
export function notionAccountOf(value: unknown): NotionAccountText {
  const found: NotionAccountText = { workspace: null, name: null, email: null };
  let budget = 500;
  const visit = (node: unknown, depth: number, owner: boolean) => {
    if (depth > 6 || budget-- <= 0) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) visit(item, depth + 1, owner);
      return;
    }
    const row = record(node);
    if (!row) return;
    found.workspace ??=
      Text.safeParse(row.workspace_name).data ??
      Text.safeParse(row.workspaceName).data ??
      Text.safeParse(record(row.workspace)?.name).data ??
      null;
    const email =
      Email.safeParse(row.email).data ?? Email.safeParse(record(row.person)?.email).data;
    if (email && !found.email) {
      found.email = email;
      found.name ??= Text.safeParse(row.name).data ?? null;
    }
    if (owner || row.type === "person") found.name ??= Text.safeParse(row.name).data ?? null;
    for (const [key, child] of Object.entries(row))
      if (child && typeof child === "object")
        visit(
          child,
          depth + 1,
          key === "owner" || key === "user" ? owner || key === "owner" : false,
        );
  };
  visit(payloadOf(value).value, 0, false);
  return found;
}

/**
 * The connection a Notion knowledge source owns. It is installed disabled like any other
 * connection: the UI runs `connectors.authorize` next, which enables it with the OAuth credential
 * the person granted, so nothing here ever holds a token.
 */
export function notionManifest(): ConnectorManifest {
  return {
    schemaVersion: 1,
    id: "pibot.notion",
    version: "1",
    name: { zh: "Notion", en: "Notion" },
    description: {
      zh: "在 Notion 里搜索页面、读取页面内容。",
      en: "Search and read pages in Notion.",
    },
    servers: [
      {
        id: "notion",
        transport: "http",
        url: NOTION_MCP_URL,
        headers: {},
        auth: { kind: "oauth", secretNames: [] },
        networkDomains: [NOTION_DOMAIN],
      },
    ],
  };
}

/**
 * What one query brings. `tools` and `call` are injected because only the caller knows the Bot,
 * the run and the approval: `call` is the connector channel that repeats policy before every
 * remote call, and the tool list is the persisted catalog (what the person left enabled).
 */
export interface NotionAccess {
  signal: AbortSignal;
  tools(): readonly Pick<ConnectorTool, "tool" | "readOnly">[];
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface NotionHit {
  /** Page or database id: what `readNotion` takes to open this hit. */
  ref: string;
  title: string;
  /** Notion's own page URL, so a reply can cite the page the person already knows. */
  url: string;
  snippet: string;
}

export interface NotionSearch {
  query: string;
  hits: NotionHit[];
}

export interface NotionPage {
  ref: string;
  title: string;
  url: string;
  text: string;
  /** The page is longer than one read returns. */
  truncated: boolean;
}

export async function searchNotion(query: string, access: NotionAccess): Promise<NotionSearch> {
  const text = query.trim();
  if (!text) throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_notion_query_empty");
  const tool = pickTool(access, SEARCH_TOOLS, "knowledge_notion_search_tool_missing");
  const value = await access.call(tool, { query: text }, access.signal);
  access.signal.throwIfAborted();
  return { query: text, hits: hitsOf(value) };
}

export async function readNotion(ref: string, access: NotionAccess): Promise<NotionPage> {
  const id = ref.trim();
  if (!id) throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_notion_ref_empty");
  const tool = pickTool(access, READ_TOOLS, "knowledge_notion_read_tool_missing");
  // Notion's hosted server names the argument `id`; the API-shaped fallback keeps the API's
  // `page_id`. Sending both would fail schema validation on either server.
  const args = tool === "API-retrieve-a-page" ? { page_id: id } : { id };
  const payload = payloadOf(await access.call(tool, args, access.signal));
  access.signal.throwIfAborted();
  const row = record(payload.value);
  const raw = bodyText(payload.value);
  return {
    ref: id,
    title: titleOf(row) ?? firstHeading(raw) ?? titleFromText(raw) ?? id,
    url: stringOf(row?.url) ?? pageUrl(id),
    text: raw.length > MAX_PAGE_CHARS ? raw.slice(0, MAX_PAGE_CHARS) : raw,
    // The host's guard truncates before this module sees the answer; a page cut there is just as
    // incomplete as one cut at MAX_PAGE_CHARS, even when JSON parsing failed and `raw` is a prefix.
    truncated: payload.truncated || raw.length > MAX_PAGE_CHARS,
  };
}

/**
 * Only a read-only tool may be called here: the channel refuses writes anyway, and choosing one
 * now turns "this connection cannot answer knowledge questions" into an error before any remote
 * call, instead of a denial in the middle of a Bot's turn.
 */
function pickTool(access: NotionAccess, candidates: readonly string[], missing: string): string {
  const tools = access.tools();
  for (const name of candidates) {
    const match = tools.find((tool) => tool.tool === name && tool.readOnly);
    if (match) return match.tool;
  }
  throw new RpcError(RpcErrorCodes.unsupported, missing);
}

/**
 * MCP answers arrive either as structured content or as one JSON text block; a server that
 * answers in prose still counts as an answer. Anything else is treated as "no results" rather than
 * an error, because an empty search is a real outcome.
 */
function payloadOf(value: unknown): { value: unknown; truncated: boolean } {
  const result = record(value);
  if (!result) return { value, truncated: false };
  const guard = record(record(result.details)?.outputGuard);
  const truncated = guard?.truncated === true;
  if (result.structuredContent !== undefined && result.structuredContent !== null)
    return { value: result.structuredContent, truncated };
  const content = Array.isArray(result.content) ? result.content : [];
  const blocks: string[] = [];
  for (const item of content) {
    const text = record(item)?.text;
    if (typeof text === "string") blocks.push(text);
  }
  // The adapter appends `structuredContent:` as its own block after ordinary content; prefer it
  // over prose because it is the machine-readable answer.
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block === undefined) continue;
    const marker = "structuredContent:\n";
    if (!block.startsWith(marker)) continue;
    const parsed = parseJson(block.slice(marker.length));
    if (parsed !== undefined) return { value: parsed, truncated };
  }
  for (const text of blocks) {
    const parsed = parseJson(text);
    if (parsed !== undefined) return { value: parsed, truncated };
  }
  // A truncated JSON prefix cannot be parsed; drop the host's English notice so the caller can
  // mark the page incomplete and add its own localized truncation note.
  return { value: blocks.map(stripGuardNotice).join("\n"), truncated };
}

function hitsOf(value: unknown): NotionHit[] {
  const body = payloadOf(value).value;
  const items = Array.isArray(body)
    ? body
    : Array.isArray(record(body)?.results)
      ? (record(body)?.results as unknown[])
      : [];
  const hits: NotionHit[] = [];
  for (const item of items) {
    const hit = hitOf(item);
    if (hit) hits.push(hit);
  }
  return hits;
}

function hitOf(item: unknown): NotionHit | null {
  const row = record(item);
  if (!row) return null;
  const id = stringOf(row.id) ?? stringOf(row.page_id) ?? stringOf(row.database_id);
  if (!id) return null;
  return {
    ref: id,
    title: titleOf(row) ?? id,
    url: stringOf(row.url) ?? pageUrl(id),
    snippet: snippetOf(row),
  };
}

/** Notion returns the title either as a plain string or as the name property's rich text. */
function titleOf(row: Record<string, unknown> | undefined): string | undefined {
  if (!row) return undefined;
  const title = stringOf(row.title);
  if (title) return title;
  const properties = record(row.properties);
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    const property = record(value);
    const rich = value && record(value)?.title;
    const first = Array.isArray(rich) ? record(rich[0]) : property?.title;
    const text = stringOf(record(first)?.plain_text) ?? stringOf(record(first)?.text);
    if (text) return text;
  }
  return undefined;
}

/** A hit's snippet is whatever the server put beside the title; absent means an empty snippet. */
function snippetOf(row: Record<string, unknown>): string {
  for (const key of ["snippet", "text", "description", "excerpt", "highlight"]) {
    const value = stringOf(row[key]);
    if (value) return cut(value);
  }
  return "";
}

/** Page text as markdown: the field Notion echoes back, or the text blocks of a content list. */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  const row = record(body);
  if (!row) return "";
  for (const key of ["markdown", "text", "content"]) {
    const value = stringOf(row[key]);
    if (value) return value;
  }
  const blocks = Array.isArray(row.content) ? row.content : [];
  return blocks.map((block) => stringOf(record(block)?.text) ?? "").join("\n\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripGuardNotice(text: string): string {
  return text.replace(/\n\n\[MCP text output truncated:[^\]]*\]\s*$/, "");
}

/** A truncated JSON prefix still carries the title near its start; without this the page shows id. */
function titleFromText(text: string): string | undefined {
  const match = /"(?:title|name)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function firstHeading(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const heading = /^#{1,3}\s+(.*\S)\s*$/.exec(line)?.[1];
    if (heading) return heading;
  }
  return undefined;
}

/** `pageUrl` is the fallback for servers that omit `url`; Notion ignores the hyphens. */
function pageUrl(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cut(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET_CHARS
    ? `${trimmed.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : trimmed;
}
