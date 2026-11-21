import { workplacePrompts } from "./prompts/workplace.ts";
/** Quoted paths remain runtime data even when folder names contain newlines or markup. */
export function workplacePrompt(
  language: "zh" | "en",
  primaryPath: string,
  cwd: string,
  writeRoots: readonly string[] = [primaryPath],
) {
  const paths = JSON.stringify({ primaryPath, cwd, writeRoots });
  return language === "zh"
    ? workplacePrompts.workplacePrompt.zh({ paths })
    : workplacePrompts.workplacePrompt.en({ paths });
}
