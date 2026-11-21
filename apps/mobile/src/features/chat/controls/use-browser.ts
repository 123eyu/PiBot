import { useRuntime } from "../../../runtime/context.tsx";
import { readBrowserTabs } from "../../browser/calls.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/**
 * Whether this Bot's browser on the computer has pages (open or asleep), so the chat
 * page can offer the live view. DM only; a group Bot's browser is reached from the computer.
 */
export function useBrowser(kind: "bot" | "group", id: string) {
  const runtime = useRuntime();
  const state = useRemoteValue(
    kind === "bot" ? `browser:${id}` : undefined,
    (signal) => readBrowserTabs(runtime, { botId: id }, signal),
    ["browser.state"],
  );
  return {
    enabled: kind === "bot",
    open: !!state.value?.open || !!state.value?.sleeping,
    takeover: !!state.value?.takeover,
  };
}
