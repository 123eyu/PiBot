import type { Logger } from "@pibot/observability";
import type { PolicyResult } from "@pibot/policy";
import type {
  BrowserHostMethods,
  BrowserPage,
  BrowserRules,
  BrowserState,
  BrowserViewDisplay,
  Grant,
  HostBrowserInputEvent,
  HostBrowserRemoteFrame,
  HostBrowserView,
  PermissionsSettings,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";
import type { BrowserToolInput } from "@pibot/tools/runtime";
import type { HostCall } from "../../core/host-call.ts";
/** Host port behind the overlay, injected through `BrainHost.browserView`. */
export interface BrowserViewHost {
  scoped?(groupId: string): BrowserViewHost;
  clearGroupData?(groupId: string): Promise<void>;
  debug?(
    params: import("@pibot/protocol-base").KernelHostParams["host.browser.view.debug"],
  ): Promise<import("@pibot/protocol-base").BrowserDiagnostics>;
  inspectPoint?(
    params: import("@pibot/protocol-base").KernelHostParams["host.browser.view.inspectPoint"],
  ): Promise<import("@pibot/protocol-base").BrowserElementSummary>;
  state(botId: string): Promise<HostBrowserView>;
  visible(botId: string, visible: boolean, display?: BrowserViewDisplay): Promise<HostBrowserView>;
  /** `window: false` keeps the page hidden on the computer. */
  takeover(botId: string, on: boolean, options?: { window?: boolean }): Promise<HostBrowserView>;
  /**
   * The phone's next frame of the shared screencast (at most 2 per second, newer than
   * `after`, waiting up to `waitMs`). Absent on hosts without Bot browsers.
   */
  remoteFrame?(
    botId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ view: HostBrowserView; frame: HostBrowserRemoteFrame | null }>;
  remoteStop?(botId: string): Promise<void>;
  input(botId: string, tab: string, event: HostBrowserInputEvent): Promise<void>;
  switchTab(botId: string, tab: string): Promise<HostBrowserView>;
  /** The user closed this tab (busy for the last tab while recording). */
  closeTab(botId: string, tab: string): Promise<HostBrowserView>;
  /** Reopen the sleeping tabs. */
  wake(botId: string): Promise<HostBrowserView>;
  /** A blank tab for the user's own address. */
  newTab(botId: string): Promise<HostBrowserView>;
  clearData(botId: string): Promise<void>;
  navigate(
    botId: string,
    tab: string,
    action: "url" | "back" | "forward" | "reload",
    url?: string,
  ): Promise<HostBrowserView>;
}

/**
 * The brain-side browser bookkeeping of the tools (`BrowserService`): told when the user hands
 * back (current page for policy, a one-time note for the next tool result) and when the profile
 * was wiped (the remembered page is gone).
 */
export interface BrowserSessionPort {
  cleared?(): void;
  handBack(botId: string, url: string): void;
  forgetPage(botId: string): void;
  /**
   * Pages the user opens load under the host rules, so the
   * host must hold some: the last ones a run pushed, else the Bot's network settings.
   */
  ensureRules(botId: string, signal: AbortSignal): Promise<void>;
  /** The user opened this address; the Bot hears it once and policy judges that page. */
  userOpened(botId: string, url: string): void;
}

/**
 * Writes the chat line "you took over for N minutes · handed back to <Bot>" (a chat system
 * record, never sent to the model). Injected so this service stays free of chat storage.
 */
export interface BrowserHandBackRecorder {
  /** The conversation to record in, if it is the Bot's DM topic or one of its groups. */
  place(botId: string, conversationId: string): string | undefined;
  browserHandBack(input: {
    botId: string;
    conversationId: string;
    durationMs: number;
    domains: string[];
    /** Sites a login form was submitted on during the takeover (hostnames only). */
    signedIn?: string[];
  }): void;
}

export interface BrowserRunScope {
  botId: string;
  runId: string;
  groupId?: string;
  conversationId?: string;
  executionTaskId?: string;
  routineRunId?: string;
  routineSource?: "routine" | "trial";
}
export interface BrowserRuleInput {
  settings: PermissionsSettings;
  roots: string[];
  boundary?: WorkspaceSnapshot;
  /** The execution sensitive-read boundary, forwarded so host file navigation has the same deny set. */
  sensitiveReadRoots?: readonly string[];
}
export interface BrowserEnvironment {
  deps: {
    host: { browser?: HostCall<typeof BrowserHostMethods> };
    logger: Pick<Logger, "warn">;
    proxy?: () => { url: string } | undefined;
  };
  shutdown: { signal: AbortSignal };
  scope(context: BrowserRunScope): string | undefined;
  grants(botId: string, context?: BrowserRunScope): Grant[];
  permissions: {
    effective(id: string): PermissionsSettings;
    effectiveGroup(id: string): PermissionsSettings;
  };
  background: { ports(botId: string, groupId?: string, browser?: boolean): number[] };
  googleCompat: { enabled(scope: { botId: string } | { groupId: string }): boolean };
  /** Maintainers 2026-11-14: local-network origins a person allowed for one run. */
  privateNetwork: { origins(runId: string): string[] };
  /** The user's setting "use my own browser first" (absent = yes). */
  userBrowser: { preferred(): boolean };
}
export interface BrowserPort extends BrowserSessionPort {
  action(
    botId: string,
    input: BrowserActionInput,
    signal: AbortSignal,
    runId?: string,
  ): Promise<BrowserActionResult>;
  readonly groupId?: string;
  forGroup(groupId: string): BrowserPort;
  forContext(context: BrowserRunScope): BrowserPort;
  readonly host: HostCall<typeof BrowserHostMethods> | undefined;
  acquireRun(context: BrowserRunScope, signal: AbortSignal, temporary?: boolean): Promise<void>;
  assertRun(context: BrowserRunScope): void;
  /** Only the queue may certify SDK/tools have stopped; caller timeout cannot release a lease. */
  drainedRun(botId: string, runId: string): Promise<void>;
  pageUrl(botId: string): string | undefined;
  resolvePage(botId: string, signal: AbortSignal, runId?: string): Promise<string | undefined>;
  observe(botId: string, page: Pick<BrowserPage, "url">): void;
  takeHandBack(botId: string): string | undefined;
  takeUserOpened(botId: string): string | undefined;
  allowApprovedSite(context: BrowserRunScope, result: PolicyResult): void;
  approveSite(context: BrowserRunScope, domain: string): void;
  approveSubmit(context: BrowserRunScope, domain: string): void;
  approveDownloads(context: BrowserRunScope): void;
  writeAllowed(context: BrowserRunScope): boolean | undefined;
  setWriteAllowed(context: BrowserRunScope, allowed: boolean): void;
  rules(
    context: BrowserRunScope,
    prepared: BrowserRuleInput,
    writeRoot: string | undefined,
    downloadsAllowed: boolean,
  ): BrowserRules;
  temporaryRules(context: BrowserRunScope, prepared: BrowserRuleInput): BrowserRules;
  googleCompatibility(botId: string): boolean;
  refreshGroupGoogleCompat(groupId: string, signal: AbortSignal): Promise<void>;
  refreshGoogleCompat(botId: string, signal: AbortSignal): Promise<void>;
  refreshPermissions(
    botId: string | undefined,
    groupId: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  refreshLocalPorts(botId: string): void;
  openLocal(botId: string, url: string, signal: AbortSignal): Promise<BrowserPage>;
  configure(
    context: BrowserRunScope,
    rules: BrowserRules,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<void>;
  finishRun(context: BrowserRunScope): Promise<void>;
  isIdle(): boolean;
  dispose(): void | Promise<void>;
}
export interface BrowserViewPort {
  dispose(): Promise<void>;
  takeover(botId: string, on: boolean, conversationId?: string): Promise<BrowserState>;
}

export type BrowserActionInput = BrowserToolInput;
export interface BrowserActionResult {
  page?: BrowserPage;
  text: string;
  image?: import("@pibot/protocol-base").ImageContent;
  localFile?: { relativePath: string; extension: string };
}
