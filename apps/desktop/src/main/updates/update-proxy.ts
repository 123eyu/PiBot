// Keeps updater proxy credentials inside the owning main process and out of request headers.
import type { AppUpdater } from "electron-updater";

export function createUpdateProxy() {
  let url: string | null | undefined;
  let active: URL | undefined;
  return {
    set(value: string | null | undefined) {
      url = value;
    },
    get: () => url,
    async apply(updater: AppUpdater) {
      const proxy = url ? new URL(url) : undefined;
      active = proxy;
      await updater.netSession.closeAllConnections();
      await updater.netSession.clearAuthCache();
      await updater.netSession.setProxy(
        proxy
          ? { mode: "fixed_servers", proxyRules: `${proxy.protocol}//${proxy.host}` }
          : { mode: "system" },
      );
    },
    login(auth: Electron.AuthInfo, callback: (username: string, password: string) => void) {
      const proxy = active;
      if (
        proxy &&
        auth.isProxy &&
        auth.host === proxy.hostname &&
        auth.port === Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80))
      ) {
        callback(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password));
      } else callback("", "");
    },
    dispose() {
      url = null;
      active = undefined;
    },
  };
}
