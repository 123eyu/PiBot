import { join } from "node:path";
import { privateNetworkOrigin } from "@pibot/policy";
import { BOT_BROWSER_APP_ID, credentialSiteLabel, RpcError } from "@pibot/protocol-base";
import type { BrowserToolPort, ToolCallView } from "@pibot/tools/runtime";
import type { PreparedTool } from "../../../core/local-types.ts";
import { runYolo } from "../../../core/yolo.ts";
import {
  FolderLockError,
  folderLockText,
} from "../../../resources/workplaces/folder-write-lock.ts";
import type { BrowserActionInput } from "../../browser/port.ts";
import { approveDerived } from "../derived-approval.ts";
import type { LocalRun } from "../local-run.ts";
import { readTemporaryBrowserPage } from "./browser-fetch.ts";
import { accountChoice } from "./browser-login.ts";
import { browserRetryBoundary, stopBrowserRetries } from "./browser-retry-boundary.ts";

export function createBrowserToolPort(run: LocalRun): BrowserToolPort {
  const { local, context } = run;
  const service = () => local.browser.forContext(context);
  return {
    assertRun: () => service().assertRun(context),
    retryBoundary: (tool) => browserRetryBoundary(context, tool),
    stopRetries: (reason) => stopBrowserRetries(local, context, reason),
    isYolo: () => runYolo(local, context),
    pauseTakeover: () => context.executionClock?.pause("browser_takeover"),
    resumeTakeover: () => context.executionClock?.resume("browser_takeover"),
    approveInitialSite: (preparedView) => {
      const prepared = preparedView as PreparedTool;
      if (prepared.call.tool === "browser_open" && prepared.result.domain)
        service().approveSite(context, prepared.result.domain);
    },
    configure: async (preparedView, writeRoot, signal, force = false) => {
      const prepared = preparedView as PreparedTool;
      const browser = service();
      if (prepared.call.tool === "browser_login") {
        await browser.configure(
          context,
          browser.rules(context, prepared, writeRoot, browser.writeAllowed(context) === true),
          signal,
          force,
        );
        return;
      }
      let allowed = browser.writeAllowed(context);
      if (allowed === undefined && writeRoot) {
        const write = await run.prepare(downloadCall(prepared.call.id, writeRoot), signal);
        allowed = write.result.decision === "allow";
        browser.setWriteAllowed(context, allowed);
      }
      const locked = !!writeRoot && (await local.writeLocks.isHeld(context.runId, [writeRoot]));
      await browser.configure(
        context,
        browser.rules(context, prepared, locked ? writeRoot : undefined, allowed === true),
        signal,
        force,
      );
    },
    action: async (input, signal) => {
      const result = await service().action(
        context.botId,
        input as BrowserActionInput,
        signal,
        context.runId,
      );
      if (["browser_network", "browser_request", "browser_secret"].includes(input.tool)) {
        const args = input.args as {
          origin?: string;
          kind?: string;
          name?: string;
          method?: string;
        };
        local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "exec.finished",
          summary: "Browser network operation / 浏览器网络操作",
          detail: {
            actor: "automatic",
            toolName: input.tool,
            target: args.origin,
            reason: [args.kind ?? args.method, args.name].filter(Boolean).join(": "),
          },
        });
      }
      if (input.tool === "browser_open" && result.localFile)
        local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          // Opening a workplace file is a file read, not a command, so the records page
          // lists it with the other file operations instead of under "run".
          kind: "file.read",
          summary: "Opened a workplace file in the Bot browser / 在 Bot 浏览器打开工作位置文件",
          detail: {
            actor: "automatic",
            toolName: "browser_open",
            category: "read_file",
            path: result.localFile.relativePath,
            target: result.localFile.relativePath,
            fileExtension: result.localFile.extension,
            source: context.routineSource ?? context.auditSource ?? "chat",
            ...((context.permissionGroupId ?? context.groupId)
              ? { groupId: context.permissionGroupId ?? context.groupId }
              : {}),
          },
        });
      return result;
    },
    readTemporary: (prepared, url, signal) => readTemporaryBrowserPage(run, prepared, url, signal),
    screenshot: async (page, signal) => {
      const host = service().host;
      if (!host) throw new RpcError(-32603, "browser_unavailable");
      const shot = await host.call(
        "host.browser.screenshot",
        { botId: context.botId, runId: context.runId, tab: page.tab },
        signal,
      );
      return shot.image;
    },
    recordStep: (input) =>
      local.computerSteps.record(context, {
        toolCallId: input.toolCallId,
        app: {
          id: BOT_BROWSER_APP_ID,
          name: context.language === "zh" ? "Bot 浏览器" : "Bot browser",
        },
        method: "browser",
        stage: "background",
        target: input.target,
        action: input.action,
        result: input.result,
        ...(input.image ? { image: input.image } : {}),
        ...(input.page
          ? { page: { url: input.page.url.slice(0, 2048), title: input.page.title.slice(0, 500) } }
          : {}),
      }),
    auditInspection: (tool, toolCallId) => {
      local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "exec.finished",
        summary: "Browser inspection / 浏览器检查",
        detail: {
          actor: "automatic",
          toolName: tool,
          toolCallId,
          source: context.routineSource ?? context.auditSource ?? "chat",
        },
      });
    },
    authorizeBlocked: (call, entry, writeRoot, signal) =>
      authorizeBlocked(run, call, entry, writeRoot, signal),
    googleCompatibility: () => service().googleCompatibility(context.botId),
    observe: (page) => service().observe(context.botId, page),
    forgetPage: () => service().forgetPage(context.botId),
    takeUserOpened: () => service().takeUserOpened(context.botId),
    takeHandBack: () => service().takeHandBack(context.botId),
    loginSelection: (preparedView) => {
      const prepared = preparedView as PreparedTool;
      const login = prepared.login;
      const pageUrl = service().pageUrl(context.botId);
      // The card's answer wins over the model's name, an earlier approval for this site
      // comes next, then the display name the model passed; `accountChoice` only matches one.
      const account = prepared.call.input.account;
      const chosen = login
        ? (local.credentials.takeChoice(context.runId, prepared.call.id) ??
          local.credentials.approvedInRun(context.runId, login.site) ??
          accountChoice(login, typeof account === "string" ? account : undefined)?.id ??
          (login.accounts.length === 1 ? login.accounts[0]?.id : undefined))
        : undefined;
      return {
        available: !!local.deps.host.credentials && !!local.deps.host.browser,
        ...(login ? { login } : {}),
        ...(pageUrl ? { pageUrl } : {}),
        ...(chosen ? { chosen } : {}),
        ...(chosen
          ? { label: login?.accounts.find((account) => account.id === chosen)?.label ?? "***" }
          : {}),
      };
    },
    fillLogin: async (preparedView, chosen, signal) => {
      const prepared = preparedView as PreparedTool;
      const login = prepared.login;
      const host = local.deps.host.credentials;
      run.assertDispatch(prepared);
      const currentPage = service().pageUrl(context.botId);
      const candidates = currentPage
        ? local.credentials.candidates(context.botId, currentPage, login?.site)
        : undefined;
      if (!host || !login || !currentPage || JSON.stringify(candidates) !== JSON.stringify(login))
        throw new RpcError(-32602, "credential_not_allowed");
      const secret = await local.credentials.secretFor(context.botId, chosen, currentPage, signal);
      run.assertDispatch(prepared);
      secret.assertCurrent();
      return host.call(
        "host.browser.fillLogin",
        {
          botId: context.botId,
          ...(service().groupId ? { groupId: service().groupId } : {}),
          runId: context.runId,
          site: secret.record.site,
          username: secret.username,
          password: secret.password,
          ...(secret.totp ? { totp: secret.totp, totpExpiresAt: secret.totpExpiresAt } : {}),
        },
        signal,
      );
    },
    auditLogin: (chosen, site, label, toolCallId, reasonCode) => {
      local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "credential.filled",
        summary: "Saved account filled",
        detail: {
          actor: "system",
          credentialId: chosen,
          domain: credentialSiteLabel(site).slice(0, 200),
          target: label,
          toolCallId,
          reasonCode,
        },
      });
    },
    completeLogin: (site, chosen, page) => {
      local.credentials.approveInRun(context.runId, site, chosen);
      service().observe(context.botId, page);
      const domain = hostname(page.url);
      if (domain) service().approveSubmit(context, domain);
    },
  };
}

function downloadCall(id: string, writeRoot: string) {
  return { id, tool: "write_file", input: { path: join(writeRoot, "downloads"), content: "" } };
}

async function authorizeBlocked(
  run: LocalRun,
  call: ToolCallView,
  entry: Parameters<BrowserToolPort["authorizeBlocked"]>[1],
  writeRoot: string | undefined,
  signal: AbortSignal,
): Promise<{ approved: boolean; note?: string }> {
  const { local, context } = run;
  if (entry.kind === "site" || entry.kind === "submit") {
    const submit = entry.kind === "submit";
    const answer = await approveDerived(
      run,
      { id: call.id, tool: "browser_open", input: { url: entry.url } },
      signal,
      {
        ...(submit
          ? {
              submit: true,
              display: { id: call.id, tool: "browser_submit", input: { url: entry.url } },
            }
          : {}),
      },
    );
    if (typeof answer === "string") return { approved: false, note: answer };
    // An allowed local-network origin needs no site entry; its approval is the run's own.
    if (!submit && answer.result.reason === "private_network_run_approved")
      return { approved: true };
    const domain = answer.result.domain ?? entry.domain;
    if (!domain) return { approved: false };
    // Site lists hold domain names; an IPv6 page's form post is simply asked again next time.
    if (domain.includes(":")) return { approved: true };
    if (submit) local.browser.approveSubmit(context, domain);
    else local.browser.approveSite(context, domain);
    return { approved: true };
  }
  // A link or redirect into the user's own network: the same ask-each-time card as browser_open
  // (maintainers 2026-11-14); once allowed, the run's rules let that origin through.
  const origin = entry.kind === "private" ? privateNetworkOrigin(entry.url) : undefined;
  if (origin) {
    const answer = await approveDerived(
      run,
      { id: call.id, tool: "browser_open", input: { url: entry.url } },
      signal,
    );
    if (typeof answer === "string") return { approved: false, note: answer };
    return { approved: local.privateNetwork.origins(context.runId).includes(origin) };
  }
  if (entry.kind === "download" && writeRoot) {
    const answer = await approveDerived(run, downloadCall(call.id, writeRoot), signal);
    if (typeof answer === "string") return { approved: false, note: answer };
    try {
      await run.lockWrite(call.id, [writeRoot], signal);
    } catch (error) {
      if (!(error instanceof FolderLockError)) throw error;
      return { approved: false, note: folderLockText(error) };
    }
    local.browser.approveDownloads(context);
    return { approved: true };
  }
  return { approved: false };
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
