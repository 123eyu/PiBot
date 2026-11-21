import type { TranslationKey } from "@pibot/i18n";

// Tool names registered by the pibot-computer extension; a "computer_" prefix is tolerated.
const toolKeys: Record<string, TranslationKey> = {
  screenshot: "computerUse.tool.screenshot",
  ui_tree: "computerUse.tool.ui_tree",
  ui_action: "computerUse.tool.ui_action",
  pointer: "computerUse.tool.pointer",
  keys: "computerUse.tool.keys",
  open_app: "computerUse.tool.open_app",
  open_file: "computerUse.tool.open_file",
};
export function computerToolKey(tool: string): TranslationKey | undefined {
  if (tool.startsWith("browser_")) return "computerUse.tool.browser";
  const name = tool.startsWith("computer_") ? tool.slice("computer_".length) : tool;
  return Object.hasOwn(toolKeys, name) ? toolKeys[name] : undefined;
}
