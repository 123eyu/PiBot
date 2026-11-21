import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { SearchService } from "./search-service.ts";
export function registerSearchRpc(handle: KernelRegisterRpc, search: SearchService) {
  handle("search.getConfig", async () => search.get());
  handle("search.setConfig", (input) => search.set(input));
  handle("search.disclose", async ({ provider, expectedEndpoint }) => {
    await search.settingsSettled();
    search.disclose(provider, expectedEndpoint);
    return { ok: true };
  });
  handle("search.removeConfig", async () => {
    await search.settingsSettled();
    search.remove();
    return { ok: true };
  });
}
