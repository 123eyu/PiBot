import type { BotBrowsers, BrowserLogins } from "@pibot/browser/host";
import type { Logger } from "@pibot/observability";
import {
  type CredentialHostMethods,
  type Params,
  type Result,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { systemPreferences } from "electron";

type M = typeof CredentialHostMethods;
type Handle = <K extends keyof M>(
  method: K,
  action: (params: Params<M, K>) => Promise<Result<M, K>>,
) => void;

/**
 * Viewing a saved password needs the user's system authentication. macOS only:
 * `promptTouchID` evaluates a user-presence access control, so Macs without Touch ID (or with it
 * unavailable) get the system's login-password sheet instead. Windows / Linux have no Electron
 * API for this and report unsupported; brain then only allows editing, never viewing.
 */
async function authenticate(reason: string): Promise<Result<M, "host.credentials.authenticate">> {
  if (process.platform !== "darwin") return { ok: false, code: "unsupported" };
  try {
    await systemPreferences.promptTouchID(reason);
    return { ok: true };
  } catch {
    // The error text names only the LocalAuthentication outcome; cancel and failure look alike.
    return { ok: false, code: "cancelled" };
  }
}

/** Host methods, inside host-rpc's single wrapper. Values are never logged here. */
export function registerCredentialHost(
  handle: Handle,
  host: { browsers: BotBrowsers; logins: BrowserLogins } | undefined,
  logger: Pick<Logger, "info">,
) {
  const need = () => {
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return host;
  };
  let prompting = false;
  handle("host.browser.login.takeoverPage", async ({ botId, groupId }) => {
    const browser = need().browsers.find(botId, groupId);
    if (!browser?.open || !browser.takeover || browser.recordingActive) return null;
    const tab = browser.tab(browser.shownTab);
    return { page: browser.page(tab), documentId: tab.documentId };
  });
  handle("host.credentials.authenticate", async ({ reason }) => {
    // One system sheet at a time; a second request while one is open is refused, not queued.
    if (prompting) throw new RpcError(RpcErrorCodes.busy, "credential_auth_busy");
    prompting = true;
    try {
      const verdict = await authenticate(reason);
      logger.info(`audit credentials.authenticate ok=${verdict.ok}`);
      return verdict;
    } finally {
      prompting = false;
    }
  });
  handle(
    "host.browser.fillLogin",
    async ({
      botId,
      groupId,
      runId,
      tab,
      site,
      username,
      password,
      totp,
      totpExpiresAt,
      takeover,
    }) => {
      const { browsers, logins } = need();
      const browser = browsers.find(botId, groupId);
      if (!browser?.open) return { ok: false, code: "no_page" };
      if (takeover) {
        if (runId || !browser.takeover || browser.recordingActive)
          return { ok: false, code: "no_page" };
      } else browser.assertRun(runId);
      const result = await logins.fill(browser, {
        runId,
        site,
        username,
        password,
        ...(totp ? { totp } : {}),
        ...(totpExpiresAt ? { totpExpiresAt } : {}),
        ...(takeover ? { takeover } : {}),
        ...(tab ? { tab } : {}),
      });
      logger.info(
        `audit browser.fillLogin botId=${botId} result=${result.ok ? "filled" : result.code}`,
      );
      return result;
    },
  );
  handle("host.browser.login.capture", async ({ botId }) => need().logins.capture(botId));
  handle("host.browser.login.take", async ({ botId, captureId }) => {
    const value = need().logins.take(botId, captureId);
    if (!value) throw new RpcError(RpcErrorCodes.invalidParams, "credential_capture_gone");
    return value;
  });
  handle("host.browser.login.discard", async ({ botId, captureId }) => {
    need().logins.discard(botId, captureId);
    return null;
  });
}
