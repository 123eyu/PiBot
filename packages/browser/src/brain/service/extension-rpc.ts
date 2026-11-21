import type { CapabilityContext } from "@pibot/brain/kit";
import {
  type BrowserExtensionStatusSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import { ChatNoticesRepo, RunsRepo, SettingsRepo } from "@pibot/storage";
import type { z } from "zod";

type Status = z.infer<typeof BrowserExtensionStatusSchema>;
const unsupported = { defaultBrowser: null, supported: false, extension: "unsupported" } as const;

/**
 * The user's own browser in settings. The preference lives in settings (absent = "user");
 * whether it is used for a run is decided per run from it (BrowserRules.userBrowser), and the
 * native messaging manifests exist only while it is "user".
 */
export function registerExtensionRpc(
  handle: CapabilityContext["rpc"]["handle"],
  ctx: Pick<CapabilityContext, "db" | "peer" | "logger" | "host" | "local">,
) {
  const preference = () =>
    // Unset means the Bot browser until the extension is in the stores (maintainers 2026-11-19).
    new SettingsRepo(ctx.db).get().browserExtensionPreference === "user" ? "user" : "bot";
  const status = async (signal: AbortSignal): Promise<Status> => {
    const host = ctx.host.browser;
    const desktop = host
      ? await host.call("host.browser.extensionStatus", {}, signal).catch(() => unsupported)
      : unsupported;
    return { ...desktop, preference: preference() };
  };
  handle("browserExtension.status", (_params, { signal }) => status(signal));
  handle("browserExtension.setPreference", async ({ preference: next }, { signal }) => {
    new SettingsRepo(ctx.db).set({ browserExtensionPreference: next });
    ctx.peer.emit("settings.changed", new SettingsRepo(ctx.db).get());
    await ctx.host.browser?.call(
      "host.browser.extensionRegister",
      { enabled: next === "user" },
      signal,
    );
    const value = await status(signal);
    ctx.peer.emit("browserExtension.changed", value);
    return value;
  });
  handle("browserExtension.fallback", async ({ botId, runId }) => {
    const run = new RunsRepo(ctx.db).get(runId);
    if (!run || run.botId !== botId)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_extension_unknown_run");
    const notice = new ChatNoticesRepo(ctx.db).addBrowserExtension({
      conversationId: run.conversationId,
      botId,
    });
    if (notice) ctx.peer.emit("chat.notice", notice);
    return { ok: true as const };
  });
  handle("browserExtension.record", async ({ botId, runId, browser, action, domain }) => {
    if (runId) {
      const run = new RunsRepo(ctx.db).get(runId);
      if (!run || run.botId !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_extension_unknown_run");
    }
    ctx.local.approvals.audit.append({
      botId,
      runId: runId ?? null,
      kind: "browser.user_browser",
      summary: "Used the user's browser / 使用用户浏览器",
      detail: { browser, browserAction: action, domain },
    });
    return { ok: true as const };
  });
  /** Startup: the manifests follow the saved preference (written once, unchanged ones skipped). */
  return async (signal: AbortSignal) => {
    await ctx.host.browser
      ?.call("host.browser.extensionRegister", { enabled: preference() === "user" }, signal)
      .catch(() =>
        ctx.logger.warn(JSON.stringify({ module: "browser-extension", event: "register_failed" })),
      );
  };
}
