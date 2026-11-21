import { type CodeAnalysis, CodeAnalysisSchema } from "@pibot/protocol-base";

/** Old or damaged optional facts do not invalidate otherwise readable history. */
export function readCodeAnalysis(value: unknown): CodeAnalysis | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  try {
    const result = CodeAnalysisSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
