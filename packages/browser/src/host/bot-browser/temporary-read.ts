import { browserBlockedReason, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { BotBrowserOperations } from "../bot-browser.ts";
import { snapshotPage } from "../page/snapshot.ts";
import type { BotTab } from "../tab.ts";
import { MAX_TABS } from "./bot-browser-shared.ts";

export interface TemporaryRead {
  runId: string;
  controller: AbortController;
}

/** The host owns the tab even if the requesting RPC disconnects before receiving its id. */
export async function temporaryReadStep(
  this: BotBrowserOperations,
  input: { runId: string; operationId: string; url: string; maxChars: number },
) {
  this.assertRun(input.runId);
  if (this.temporaryReads.has(input.operationId) || this.temporaryReads.size >= 8)
    throw new RpcError(RpcErrorCodes.busy, "browser_resource_busy");
  const controller = new AbortController();
  this.temporaryReads.set(input.operationId, { runId: input.runId, controller });
  try {
    return await this.serial(async () => {
      this.assertRun(input.runId);
      controller.signal.throwIfAborted();
      if (this.takeover || this.recording.active)
        throw new RpcError(RpcErrorCodes.busy, "browser_takeover");
      if (!this.rules || this.rules.runId !== input.runId)
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_not_configured");
      const url = new URL(input.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new RpcError(RpcErrorCodes.invalidParams, "browser_unsupported_url");
      if (this.tabs.size >= MAX_TABS) throw new RpcError(RpcErrorCodes.busy, "browser_tab_limit");
      const signal = controller.signal;
      const startedSession = this.tabs.size === 0;
      const timer = setTimeout(
        () => controller.abort(new RpcError(RpcErrorCodes.timeout, "browser_timeout")),
        15_000,
      );
      let tab: BotTab | undefined;
      const jobs: Promise<unknown>[] = [];
      const close = () => {
        if (tab) this.closeTab(tab.id);
      };
      const guard = () => {
        signal.throwIfAborted();
        this.assertRun(input.runId);
        if (this.takeover || this.recording.active)
          throw new RpcError(RpcErrorCodes.busy, "browser_takeover");
      };
      const wait = async <T>(job: Promise<T>): Promise<T> => {
        jobs.push(job);
        return await new Promise<T>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void job.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        });
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        // Do not use newTab/openUrl: they select the tab and restore sleeping user pages.
        if (!this.tabs.size) this.pool.opening(this.owner);
        tab = this.createTab();
        this.temporaryTabs.add(tab.id);
        await wait(this.startTab(tab, tab.open()));
        guard();
        await wait(tab.navigate(input.url, 12_000));
        guard();
        await wait(tab.settle(500, 2000));
        guard();
        // page() drains the Bot-wide reports. This page owns only its main-frame failures.
        const target = tab;
        const page = () => ({
          tab: target.id,
          url: target.url.slice(0, 8192),
          title: target.title.slice(0, 1000),
          loading: target.loading,
          ...(target.lastError ? { error: target.lastError } : {}),
          blocked: this.temporaryBlocked.get(target.id) ?? [],
          ...(browserBlockedReason(target.url)
            ? { blockedReason: browserBlockedReason(target.url) }
            : {}),
        });
        if (page().blocked.length) return { page: page(), text: "", truncated: false };
        const snapshot = await wait(snapshotPage(tab.control, tab.refs, input.maxChars));
        guard();
        const result = page();
        if (result.loading || result.error)
          throw new RpcError(RpcErrorCodes.invalidParams, "browser_temporary_blocked");
        return { page: result, text: snapshot.text, truncated: snapshot.truncated };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", close);
        close();
        if (tab) {
          this.temporaryTabs.delete(tab.id);
          this.temporaryBlocked.delete(tab.id);
        }
        // A broken onTab/CDP adapter must not hold this Bot's serial lane forever.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cleanup = [...jobs];
          if (startedSession && !this.tabs.size) cleanup.push(this.session.closeAllConnections());
          const settled = Promise.allSettled(cleanup).then(() => true);
          const complete = await Promise.race([
            settled,
            new Promise<false>((resolve) => {
              cleanupTimer = setTimeout(() => resolve(false), 5000);
            }),
          ]);
          if (!complete)
            this.options.logger.warn(
              JSON.stringify({
                module: "browser",
                botId: this.botId,
                runId: input.runId,
                reasonCode: "temporary_cleanup_timeout",
              }),
            );
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
    });
  } finally {
    this.temporaryReads.delete(input.operationId);
  }
}
