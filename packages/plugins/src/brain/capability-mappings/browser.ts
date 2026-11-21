import { playwrightFingerprint } from "./fingerprints.ts";
import type { CapabilityMapping } from "./types.ts";

export const browserMapping: CapabilityMapping = {
  capabilityId: "browser",
  match: playwrightFingerprint,
  tools: {
    browser_navigate: "browser_open",
    browser_navigate_back: "browser_back",
    browser_snapshot: "browser_snapshot",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_select_option: "browser_select",
    browser_take_screenshot: "browser_screenshot",
    browser_screenshot: "browser_screenshot",
    browser_wait_for: "browser_wait",
    browser_tabs: "browser_tabs",
    browser_close: "browser_close",
  },
  readOnlyTools: new Set([
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_screenshot",
    "browser_wait_for",
    // The stable browser_tabs tool has no arguments; T4 always maps it to action=list and hides
    // the raw multi-action MCP tool, so new/close/select can never cross this read-only adapter.
    "browser_tabs",
  ]),
};
