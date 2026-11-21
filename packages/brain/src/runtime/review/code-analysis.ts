import type { LocalToolResult } from "@pibot/agent";
import { type CodeAnalysis, CodeAnalysisSchema } from "@pibot/protocol-base";

const syntaxFact = Symbol("program-code-analysis");
type SyntaxResult = LocalToolResult & { [syntaxFact]?: CodeAnalysis };

/** Only the built-in parser producer calls this; JSON/tool text cannot mint the symbol. */
export function syntaxCodeResult(result: LocalToolResult): LocalToolResult {
  return Object.assign(result, {
    [syntaxFact]: CodeAnalysisSchema.parse({ engine: "tree-sitter", approximate: true }),
  });
}
export function codeAnalysisOf(result: LocalToolResult | undefined): CodeAnalysis | undefined {
  const fact = (result as SyntaxResult | undefined)?.[syntaxFact];
  if (!fact) return undefined;
  const parsed = CodeAnalysisSchema.safeParse(fact);
  return parsed.success ? parsed.data : undefined;
}
