import { randomUUID } from "node:crypto";
import { blockedPage } from "@pibot/execution";
import { type BrowserHostMethods, type Result, RpcError } from "@pibot/protocol-base";
import type { PreparedToolView } from "@pibot/tools/runtime";
import { approveDerived } from "../derived-approval.ts";
import { ToolAuthorizationError } from "../local-run/local-run-shared.ts";
import type { LocalRun } from "../local-run.ts";
import { browserRetryBoundary, stopBrowserRetries } from "./browser-retry-boundary.ts";

/** Derived browser visits keep the original web step's policy and audit identity. */
export async function readTemporaryBrowserPage(
  run: LocalRun,
  prepared: PreparedToolView,
  url: string,
  signal: AbortSignal,
) {
  const { local, context } = run;
  const browser = local.browser.forContext(context);
  const host = browser.host;
  const offered = run.ports.definitions.find((tool) => tool.name === "browser_open");
  if (!host || !offered || offered.capabilityImplementation) return undefined;
  if (browserRetryBoundary(context, "browser_open")) return { needsTakeover: true };
  let leaseReady = false;
  try {
    signal.throwIfAborted();
    run.assertDispatch(prepared);
    if (!run.authorizationMatches(prepared)) return undefined;
    const approved = await approveDerived(
      run,
      { id: prepared.call.id, tool: "browser_open", input: { url } },
      signal,
      { deferBrowserLease: true },
    );
    if (typeof approved === "string" || !run.authorizationMatches(prepared)) return undefined;
    run.assertDispatch(prepared);
    if (approved.settings.levels.web === "never") return undefined;
    await browser.acquireRun(context, signal, true);
    leaseReady = true;
    if (approved.result.domain) browser.approveSite(context, approved.result.domain);
    // Keep other tabs' write/download/local-file boundaries; the host restricts this tab only.
    await browser.configure(context, browser.temporaryRules(context, approved), signal);
    const operationId = randomUUID();
    const operation = { botId: context.botId, runId: context.runId, operationId };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(21_000)]);
    let cancel: Promise<unknown> | undefined;
    const abort = () => {
      cancel ??= host
        .call("host.browser.cancelTemporary", operation, AbortSignal.timeout(5000))
        .catch(() => {
          // The host also owns a 15s deadline; transport loss cannot orphan its temporary tab.
          local.deps.logger.warn(
            JSON.stringify({
              module: "browser",
              event: "temporary_cancel_failed",
              botId: context.botId,
              runId: context.runId,
              reasonCode: "cancel_unavailable",
            }),
          );
        });
    };
    deadline.addEventListener("abort", abort, { once: true });
    let result: Result<typeof BrowserHostMethods, "host.browser.readTemporary">;
    try {
      result = await host.call(
        "host.browser.readTemporary",
        { ...operation, url, maxChars: 60_000 },
        deadline,
      );
    } finally {
      deadline.removeEventListener("abort", abort);
      if (deadline.aborted) abort();
      await cancel;
    }
    signal.throwIfAborted();
    browser.assertRun(context);
    run.assertDispatch(prepared);
    if (!run.authorizationMatches(prepared)) return undefined;
    const page = result.page;
    if (page.blocked.length) return undefined;
    if (
      page.blockedReason ||
      /\/(?:login|signin|sign-in)(?:\/|$)/i.test(new URL(page.url).pathname) ||
      (result.text.length <= 3000 &&
        /sign in to continue|log in to continue|请登录后|登录后继续/i.test(result.text)) ||
      blockedPage({ status: 200, url: page.url }, `${page.title}\n${result.text}`) ||
      !result.text.trim()
    )
      return { needsTakeover: true };
    return {
      page: {
        url: page.url,
        domain: new URL(page.url).hostname,
        title: local.deps.redactor.redact(page.title),
        text: local.deps.redactor.redact(result.text),
        length: result.text.length,
        truncated: result.truncated,
        mimeType: "text/html",
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === "browser_takeover") {
      stopBrowserRetries(local, context, "takeover");
      return { needsTakeover: true };
    }
    if (error instanceof ToolAuthorizationError) throw error;
    run.assertDispatch(prepared);
    if (leaseReady) browser.assertRun(context);
    if (leaseReady && error instanceof RpcError && error.message === "browser_resource_busy")
      throw error;
    local.deps.logger.warn(
      JSON.stringify({
        module: "browser",
        event: "temporary_read_failed",
        botId: context.botId,
        runId: context.runId,
        errorName:
          error instanceof TypeError
            ? "TypeError"
            : error instanceof RpcError
              ? "RpcError"
              : "Error",
        ...(error instanceof RpcError ? { errorCode: error.code } : {}),
      }),
    );
    if (!(error instanceof RpcError)) throw error;
    return undefined;
  }
}
