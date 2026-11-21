import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import type { CodeMapSymbol } from "@pibot/execution/codemap";
import {
  SemanticError,
  type SemanticFailure,
  type SourceAccess,
  type SourceRefusal,
} from "@pibot/execution/semantic";
import {
  CodeMapSchema,
  CodeOutlineResultSchema,
  CodeOutlineSchema,
  CodeSymbolsResultSchema,
  CodeSymbolsSchema,
  RpcError,
} from "@pibot/protocol-base";
import type { CodeMapSymbolRow } from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { redactValue } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import type { LocalRun } from "../tools/local-run.ts";
import { syntaxCodeResult } from "./code-analysis.ts";
import { codeMapOutput } from "./code-map-output.ts";
import { summarizeReasons } from "./code-reasons.ts";
import { reviewSourceAccess } from "./review-source-access.ts";

const DEFAULT_OUTLINE = 200;
const DEFAULT_SYMBOLS = 50;
const DEFAULT_TOKENS = 1_000;
/**
 * The ranked map only needs the head of the list: reading every definition of a huge root into
 * memory to drop 95% of it would cost more than the answer is worth.
 */
const MAX_ENTRY_ROWS = 20_000;
const TIMEOUT_MS = 60_000;

/**
 * An outline of one file names the refusal it hit, because "unsupported language" for a
 * 2 MiB file or a binary file sent the model to fix the wrong thing. Causes the model cannot act
 * on separately (denied, outside the root) share one code; changed files can be retried.
 */
function outlineFailure(
  refusal: SourceRefusal | "unsupported_language" | "not_parsed",
): SemanticFailure {
  switch (refusal) {
    case "changed":
      return "file_changed";
    case "unsupported_language":
    case "file_too_large":
    case "not_utf8":
    case "not_parsed":
      return refusal;
    default:
      return "file_unreadable";
  }
}

/** Wire shape of a range; the stored row keeps both ends as scalars for querying. */
function toRange(
  row: Pick<CodeMapSymbolRow, "startLine" | "startColumn" | "endLine" | "endColumn">,
) {
  return {
    line: row.startLine,
    column: row.startColumn,
    endLine: row.endLine,
    endColumn: row.endColumn,
  };
}

/** A definition nests inside another when its range is contained; same-line symbols nest by column. */
function contains(outer: CodeMapSymbolRow, inner: CodeMapSymbolRow): boolean {
  const afterStart =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
  const beforeEnd =
    outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);
  return afterStart && beforeEnd;
}

/**
 * Depth for a flat outline. Sorting by start and keeping the open ranges on a stack is O(n log n);
 * comparing every pair would be quadratic on generated files with thousands of symbols.
 */
function nesting(symbols: readonly CodeMapSymbol[]): { symbol: CodeMapSymbol; depth: number }[] {
  const sorted = [...symbols].sort(
    (a, b) =>
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn ||
      b.endLine - a.endLine ||
      b.endColumn - a.endColumn,
  );
  const open: CodeMapSymbolRow[] = [];
  return sorted.map((symbol) => {
    while (open.length && !contains(open[open.length - 1] as CodeMapSymbolRow, symbol)) open.pop();
    const depth = open.length;
    open.push(symbol);
    // Name ranges no longer enclose members; the parser keeps nesting from full declaration nodes.
    return { symbol, depth: symbol.depth ?? depth };
  });
}

/**
 * `code_outline` / `code_symbols` / `code_map` over the incremental index. Every answer is
 * filtered against the current authorization before it leaves, because the index is derived data
 * that outlives the consent which built it.
 */
export class CodeMapTools {
  constructor(private readonly local: LocalService) {}

  async outline(run: LocalRun, prepared: PreparedTool, input: unknown, signal: AbortSignal) {
    const current = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const args = CodeOutlineSchema.parse(input);
    const root = this.root(prepared);
    const path = this.scope(root, args.path);
    if (!path) throw new RpcError(-32602, "semantic_file_unavailable");
    const limit = args.limit ?? DEFAULT_OUTLINE;
    const file = await this.local.codeMap.fileSymbols(run.context, root, path, current);
    if (!file.ok) throw new SemanticError(outlineFailure(file.refusal));
    const lines = file.text.split("\n");
    // Tags describe named declarations, unlike the semantic navigation tree's local variables
    // and synthetic placeholders. Keep those placeholders out even if a grammar emits one.
    const declarations = file.symbols.filter(
      (symbol) => symbol.definition && symbol.name !== "<unknown>" && symbol.kind !== "local var",
    );
    const outline = nesting(declarations)
      .slice(0, limit)
      .map(({ symbol, depth }) => ({
        name: symbol.name,
        // An empty kind would make the whole reply fail the schema; "unknown" says the same.
        kind: symbol.kind || "unknown",
        depth,
        range: toRange(symbol.declarationRange ?? symbol),
        preview: (lines[symbol.startLine - 1] ?? "").trim().slice(0, 240),
      }));
    const truncated = declarations.length > outline.length;
    const reasons = summarizeReasons(file.reasons);
    // Reference extraction has its own budget; reaching it does not omit definitions.
    const partial =
      truncated ||
      file.reasons.some(
        (reason) => reason !== "reference_limit" && !reason.startsWith("reference_limit:"),
      );
    const result = CodeOutlineResultSchema.parse({
      engine: "tree-sitter",
      approximate: true,
      path,
      hash: file.hash,
      outline,
      truncated,
      partial,
      reasons,
    });
    return this.finish(run.context, "code_outline", result, `${outline.length} declarations`);
  }

  async symbols(run: LocalRun, prepared: PreparedTool, input: unknown, signal: AbortSignal) {
    const current = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const args = CodeSymbolsSchema.parse(input);
    const root = this.root(prepared);
    const prefix = this.scope(root, args.path) || undefined;
    const limit = args.limit ?? DEFAULT_SYMBOLS;
    const index = await this.local.codeMap.refresh(run.context, root, current);
    const counts = this.local.codeMap.counts(index.rootKey);
    // Ask for twice the limit: the authorization filter below can only remove rows.
    const hits = this.local.codeMap.search(index.rootKey, args.query, { prefix, limit: limit * 2 });
    const access = await reviewSourceAccess(this.local, run.context, root, current);
    const allowed = await this.authorized(
      access,
      root,
      hits.map((hit) => hit.path),
      current,
    );
    const visible = hits.filter((hit) => allowed.has(hit.path));
    const definitions = visible.filter((hit) => hit.definition).slice(0, limit);
    const references = visible.filter((hit) => !hit.definition).slice(0, limit);
    const reasons = new Set(index.reasons);
    if (visible.length !== hits.length) reasons.add("denied_or_unavailable");
    const result = CodeSymbolsResultSchema.parse({
      engine: "tree-sitter",
      approximate: true,
      query: args.query,
      // Only what the schema keeps is reported: the same row shape per file keeps lookups cheap.
      definitions: definitions.map((hit) => this.hit(hit)),
      references: references.map((hit) => this.hit(hit)),
      indexed: { files: counts.files, symbols: counts.symbols },
      truncated:
        definitions.length < visible.filter((hit) => hit.definition).length ||
        references.length < visible.filter((hit) => !hit.definition).length,
      reasons: summarizeReasons(reasons),
    });
    return this.finish(
      run.context,
      "code_symbols",
      result,
      `${definitions.length} definitions · ${references.length} references`,
    );
  }

  async map(run: LocalRun, prepared: PreparedTool, input: unknown, signal: AbortSignal) {
    const current = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const args = CodeMapSchema.parse(input);
    const root = this.root(prepared);
    const prefix = this.scope(root, args.path) || undefined;
    const maxTokens = args.maxTokens ?? DEFAULT_TOKENS;
    const index = await this.local.codeMap.refresh(run.context, root, current);
    const counts = this.local.codeMap.counts(index.rootKey);
    const rows = this.local.codeMap.entries(index.rootKey, { prefix, limit: MAX_ENTRY_ROWS });
    const access = await reviewSourceAccess(this.local, run.context, root, current);
    const allowed = await this.authorized(
      access,
      root,
      rows.map((row) => row.path),
      current,
    );
    const reasons = new Set(index.reasons);
    if (rows.some((row) => !allowed.has(row.path))) reasons.add("denied_or_unavailable");
    const { result, text } = codeMapOutput(
      rows.filter((row) => allowed.has(row.path)),
      {
        engine: "tree-sitter",
        approximate: true,
        scope: args.path === undefined ? "." : (prefix ?? "."),
        maxTokens,
        indexed: { files: counts.files, symbols: counts.symbols },
        truncated: rows.length >= MAX_ENTRY_ROWS,
        reasons: summarizeReasons(reasons),
      },
      (payload) => JSON.stringify(redactValue(payload, this.local.deps.redactor)),
    );
    return this.finish(
      run.context,
      "code_map",
      result,
      `${result.files.length} files · ~${result.estimatedTokens} tokens`,
      text,
    );
  }

  /** The tool's policy decision was made for the working root; anything else needs its own ask. */
  private root(prepared: PreparedTool): string {
    if (prepared.result.path?.path !== prepared.cwd)
      throw new RpcError(-32602, "semantic_root_consent_required");
    return prepared.cwd;
  }

  /** A path inside the root as a POSIX relative path; empty means the root itself. */
  private scope(root: string, path: string | undefined): string {
    if (path === undefined) return "";
    const normalized = relative(root, resolve(root, path)).split(sep).join("/");
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized === "." ||
      isAbsolute(normalized)
    )
      throw new RpcError(-32602, "outside_workplace_denied");
    return normalized;
  }

  /** Re-authorizes every returned path: rows indexed under an older consent must not leak text. */
  private async authorized(
    access: SourceAccess,
    root: string,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const allowed = new Set<string>();
    for (const path of new Set(paths)) {
      if (allowed.has(path)) continue;
      if (await access.authorize(resolve(root, path), "file", signal)) allowed.add(path);
    }
    return allowed;
  }

  private hit(hit: {
    path: string;
    hash: string;
    name: string;
    kind: string;
    definition: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }) {
    return {
      path: hit.path,
      hash: hit.hash,
      name: hit.name,
      kind: hit.kind || "unknown",
      range: {
        line: hit.startLine,
        column: hit.startColumn,
        endLine: hit.endLine,
        endColumn: hit.endColumn,
      },
    };
  }

  private finish(
    context: ToolRunContext,
    tool: "code_outline" | "code_symbols" | "code_map",
    payload: unknown,
    summary: string,
    text?: string,
  ): LocalToolResult {
    this.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "exec.finished",
      summary: "Syntax-level code map completed",
      detail: {
        toolName: tool,
        reasonCode:
          typeof payload === "object" &&
          payload &&
          (("partial" in payload && payload.partial) ||
            ("truncated" in payload && payload.truncated))
            ? "partial"
            : "complete",
      },
    });
    return syntaxCodeResult({
      text: text ?? JSON.stringify(redactValue(payload, this.local.deps.redactor)),
      summary: `tree-sitter · approximate / 语法级近似 · ${summary}`,
    });
  }
}
