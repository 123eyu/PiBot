import { type BrowserSecretUse, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { BotBrowser } from "../bot-browser.ts";
import type { BotTab } from "../tab.ts";

const refused = () => new RpcError(RpcErrorCodes.invalidParams, "secret_handle_refused");
function describe(tab: BotTab, handle: string, destination: string): BrowserSecretUse {
  const mask = tab.networkMask();
  const entry = mask?.get(handle);
  if (!mask || !entry) throw refused();
  return {
    handle,
    tab: tab.id,
    documentId: tab.documentId,
    kind: entry.kind,
    site: mask.known(entry.site),
    name: mask.known(entry.name),
    length: entry.value.length,
    destination,
  };
}

/** Lookups are scoped by the host-selected Bot/profile; no model-supplied Bot id is trusted. */
export function describeSecretUses(
  browser: BotBrowser,
  input: {
    tab?: string;
    origin?: string;
    uses: { handle: string; destination: string }[];
  },
) {
  const tabs =
    input.tab || input.origin
      ? [browser.tab(input.tab)]
      : browser.tabList().map(({ tab }) => browser.tab(tab));
  return {
    uses: input.uses.map(({ handle, destination }) => {
      const tab = tabs.find((candidate) => candidate.networkMask()?.get(handle));
      if (!tab) throw refused();
      const use = describe(tab, handle, destination);
      if (
        input.origin !== undefined &&
        (use.site !== input.origin || new URL(tab.url).origin !== input.origin)
      )
        throw refused();
      return use;
    }),
  };
}

/** Only the trusted post-approval command adapter calls this port; there is no reveal tool. */
export function consumeSecretUses(browser: BotBrowser, uses: BrowserSecretUse[]) {
  return {
    values: uses.map((use) => {
      const tab = browser.tab(use.tab);
      const current = describe(tab, use.handle, use.destination);
      if (JSON.stringify(current) !== JSON.stringify(use)) throw refused();
      const entry = tab.networkMask()?.get(use.handle);
      if (!entry || entry.value.includes("\0")) throw refused();
      return { handle: use.handle, value: entry.value };
    }),
  };
}
