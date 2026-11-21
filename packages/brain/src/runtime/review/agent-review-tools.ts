import {
  CodeMapSchema,
  CodeNavigateSchema,
  CodeOutlineSchema,
  CodeSymbolsSchema,
  DeliveryEvidenceInputSchema,
  ReviewReadSchema,
  ReviewStartSchema,
} from "@pibot/protocol-base";
export const agentReviewSchemas = {
  code_navigate: CodeNavigateSchema,
  code_outline: CodeOutlineSchema,
  code_symbols: CodeSymbolsSchema,
  code_map: CodeMapSchema,
  review_start: ReviewStartSchema,
  review_read: ReviewReadSchema,
  delivery_evidence: DeliveryEvidenceInputSchema,
};
export const agentReviewDescriptions: Record<keyof typeof agentReviewSchemas, string> = {
  review_read:
    "Only in an independent review task: read its immutable manifest, diff or one frozen source file. The server checks original source permissions on every read. Missing snapshot data never falls back to current files.",
  code_navigate:
    "Read TS/JS code structure: `definition`, `references`, `callers` / `callees` (one call level) and `implementations`, either at a 1-based UTF-16 position or with `query` naming the declaration inside `path`; `symbol` searches declarations by name; `outline` lists one file's declarations; `diagnostics` reports a file's errors. A name that matches several declarations is never guessed: `symbols` lists the candidates with reason `ambiguous_symbol`, so re-run with the chosen line + column. Uses a bounded TypeScript 6.0.3 snapshot, no project plugins or commands. Prefer `code_outline` for a fast single-file syntax outline; use this tool for type-aware navigation and diagnostics, then `read_file` only the ranges you need. Partial results are not a full project build or proof of no errors. / 文件大纲优先用 code_outline，类型导航和诊断用 code_navigate，再按需读相关范围；名字对应多个声明时先看候选，再带行列号重试。",
  code_outline:
    "One file's named declaration outline, in source order, for any supported language including TS/JS. Reads only that file through the authorized tree-sitter parser, without scanning the project or type-checking. Syntax-level and approximate: name matching may have false positives or misses. Each result carries `engine`, `approximate`, the file hash, `partial` and bounded reasons; partial describes extraction limits, not type correctness. Prefer this over reading a whole file, then `read_file` only the ranges you need. / 任意支持语言（含 TS/JS）的具名声明大纲，按源码位置排序，只读目标文件、不扫描项目或类型检查；语法级、按名字匹配，可能有误报或漏报；partial 表示提取受限，不表示类型正确性。",
  code_symbols:
    "Find definition and reference sites by name in the working root (optionally under `path`), from the incremental tree-sitter index. Syntax-level, exact spelling only: qualified names, generated names or macros may be missed, and results are approximate. Re-authorizes every returned file before answering. Re-run with `path` when a name is common. / 按名字找定义与引用，来自增量 tree-sitter 索引；语法级、只按拼写精确匹配，可能有误报或漏报。",
  code_map:
    "A repository map: files with their key classes and functions, ranked by how often their names are referenced, truncated to a token budget (default 1000, max 4000, estimated as characters / 4). Narrow it with `path` (a subdirectory) and use `code_outline` / `code_symbols` / `read_file` afterwards. Syntax-level and approximate, not a dependency graph. / 仓库地图：文件的关键类与函数，按被引用次数排序，按 token 预算截断；语法级近似，不是依赖图。",
  review_start:
    "Start a genuinely independent read-only Plan subtask reviewing an immutable code/diff snapshot. Uses the same budget/cancellation tree; no writes, browser, network or child spawns. Findings are version-bound and become stale after changes. Do not claim PASS from an empty result.",
  delivery_evidence:
    "Attach actual command tool record IDs, actual screenshot step IDs, independent review IDs and explicit unverified items from this run tree. The server derives exit codes and availability; never invent PASS, paths or results.",
};
export function isAgentReviewTool(name: string): name is keyof typeof agentReviewSchemas {
  return Object.hasOwn(agentReviewSchemas, name);
}
