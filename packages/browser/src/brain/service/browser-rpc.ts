import type {
  BrowserHandBackRecorder,
  BrowserSessionPort,
  BrowserViewHost,
  RegisterRpc,
} from "@pibot/brain/kit";
import { normalizeAddress, siteOf } from "@pibot/brain/kit";
import type { BrowserRemoteActor, BrowserRemoteView } from "@pibot/browser-contract/full";
import {
  type BrowserInputEvent,
  type BrowserState,
  type BrowserViewDisplay,
  type Events,
  HostBrowserTabIdSchema,
  type HostBrowserView,
  type Methods,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { AuditRepo } from "@pibot/storage";
import { toHostInput } from "./browser-input.ts";

interface Takeover {
  since: number;
  /** Where the user took over from; no place (older client, foreign id) means no chat line. */
  conversationId?: string;
  /** Sites seen while taken over, in order, hostnames only (never what was typed). */
  domains: string[];
  /** The phone that holds this takeover; absent for the desktop user. */
  actor?: BrowserRemoteActor;
}

const EMIT_THROTTLE_MS = 300;
/** How long one phone frame request waits for a new frame before answering "none". */
const REMOTE_WAIT_MS = 4000;
const elsewhere = () => new RpcError(RpcErrorCodes.busy, "browser_takeover_elsewhere");
const MAX_NOTICE_DOMAINS = 3;

function hostTab(tabId: string) {
  const parsed = HostBrowserTabIdSchema.safeParse(tabId);
  if (!parsed.success) throw new RpcError(RpcErrorCodes.invalidParams, "browser_tab_not_found");
  return parsed.data;
}

const plain = (value: string, max: number) =>
  [...value]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(0, max);

/**
 * Overlay state, takeover bookkeeping and the `browser.state` event. Owns no browser: every
 * call goes to the background host, which also enforces takeover (Bot calls get busy) and
 * never screenshots or records during it.
 */
export class BrowserViewService {
  private readonly groupViews = new Map<string, BrowserViewService>();
  scoped(botId: string, groupId?: string): BrowserViewService {
    if (!groupId) return this;
    if (!this.deps.groups?.members(groupId).includes(botId))
      throw new RpcError(-32602, "group_permission_scope_changed");
    let value = this.groupViews.get(groupId);
    if (!value) {
      const host = this.host.scoped?.(groupId);
      if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
      value = new BrowserViewService({
        ...this.deps,
        host,
        groupId,
        session: this.deps.groups.session(groupId),
        audit: {
          append: (entry) =>
            this.deps.audit.append({ ...entry, detail: { ...entry.detail, groupId } }),
        },
      });
      this.groupViews.set(groupId, value);
    }
    return value;
  }
  async clearGroupData(groupId: string) {
    const members = this.deps.groups?.members(groupId);
    if (!members?.[0]) throw new RpcError(-32602, "group_permission_scope_changed");
    if (!this.host.clearGroupData)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    await this.host.clearGroupData(groupId);
    this.deps.groups?.session(groupId).cleared?.();
    for (const botId of members) {
      const scoped = this.scoped(botId, groupId);
      scoped.deps.session?.forgetPage(botId);
      await scoped.state(botId);
    }
    this.deps.audit.append({
      botId: members[0],
      kind: "browser.data_cleared",
      summary: "Group browser data cleared / 群浏览器数据已清理",
      detail: { actor: "user", groupId },
    });
    return { ok: true as const };
  }
  private readonly last = new Map<string, string>();
  private readonly activity = new Map<string, string>();
  private readonly takeovers = new Map<string, Takeover>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly deps: {
      host: BrowserViewHost | undefined;
      peer: Pick<Peer<typeof Methods, typeof Events>, "emit">;
      logger: Pick<Logger, "info" | "warn">;
      audit: Pick<AuditRepo, "append">;
      /** Set after construction: the tools' service lives in LocalService. */
      session?: BrowserSessionPort;
      notices?: BrowserHandBackRecorder;
      now?: () => number;
      /** Synchronous reservation closes the gap before the host reports takeover state. */
      beginTakeover?: (botId: string) => () => void;
      groupId?: string;
      groups?: { members(groupId: string): string[]; session(groupId: string): BrowserSessionPort };
    },
  ) {}

  private get host() {
    if (!this.deps.host || this.disposed)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    return this.deps.host;
  }

  private publish(botId: string, view: HostBrowserView): BrowserState {
    const taken = this.takeovers.get(botId);
    if (taken && view.takeover) this.noteSite(taken, view);
    const state: BrowserState = {
      botId,
      ...(this.deps.groupId ? { groupId: this.deps.groupId } : {}),
      open: view.open,
      tabs: view.tabs.map((tab) => ({
        id: tab.tab,
        url: plain(tab.url, 2048),
        title: plain(tab.title, 500),
        active: tab.active,
        loading: tab.loading,
        ...(tab.error ? { error: tab.error } : {}),
        ...(tab.sleeping ? { sleeping: true } : {}),
      })),
      takeover: view.takeover,
      viewing: view.viewing,
      recording: view.recording,
      lastActivityAt: this.activity.get(botId) ?? null,
      ...(view.sleeping ? { sleeping: true } : {}),
    };
    const key = JSON.stringify(state);
    if (this.last.get(botId) !== key) {
      this.last.set(botId, key);
      this.deps.peer.emit("browser.state", state);
    }
    return state;
  }

  private touch(botId: string) {
    this.activity.set(botId, new Date(this.deps.now?.() ?? Date.now()).toISOString());
  }

  async state(botId: string) {
    return this.publish(botId, await this.host.state(botId));
  }

  async view(botId: string, visible: boolean, display?: BrowserViewDisplay) {
    return this.publish(botId, await this.host.visible(botId, visible, display));
  }

  async switchTab(botId: string, tabId: string) {
    return this.publish(botId, await this.host.switchTab(botId, hostTab(tabId)));
  }

  /**
   * The user closes a tab from the strip, any time (no takeover needed). The host makes a
   * Bot action on that tab fail with "the user closed the tab". Closing the last tab closes the
   * Bot's pages: the tools forget the page, and a takeover in progress is handed back (there is
   * nothing left to drive). Audited with the site only, never the full address.
   */
  async closeTab(botId: string, tabId: string) {
    const tab = hostTab(tabId);
    const before = await this.host.state(botId);
    const url = before.tabs.find((entry) => entry.tab === tab)?.url ?? "";
    let view = await this.host.closeTab(botId, tab);
    const site = siteOf(url);
    this.deps.audit.append({
      botId,
      kind: "browser.tab_closed",
      summary: "User closed a Bot browser tab",
      detail: { actor: "user", ...(site ? { domain: site.slice(0, 200) } : {}) },
    });
    this.touch(botId);
    if (!view.open) {
      if (view.takeover) {
        await this.takeover(botId, false);
        view = await this.host.state(botId);
      }
      this.deps.session?.forgetPage(botId);
    }
    return this.publish(botId, view);
  }

  private rules(botId: string) {
    return (
      this.deps.session?.ensureRules(
        botId,
        AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
      ) ?? Promise.resolve()
    );
  }

  /**
   * The address bar (during takeover and at any other time). The user's own address is not asked
   * about, but the host rules still refuse private and unlisted addresses (notice page). Outside
   * takeover the Bot hears "the user just opened <url>" with its next browser result, and policy
   * judges that page. Audited with the site only.
   */
  async navigate(
    botId: string,
    tabId: string,
    action: "url" | "back" | "forward" | "reload",
    url: string | undefined,
    actor?: BrowserRemoteActor,
  ) {
    if (actor) this.assertPhoneOwner(botId, actor);
    if (action === "url" && !url)
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_url_required");
    const target = action === "url" && url ? normalizeAddress(url) : undefined;
    const taken = this.takeovers.has(botId);
    if (!taken) await this.rules(botId);
    const view = await this.host.navigate(botId, hostTab(tabId), action, target);
    this.touch(botId);
    if (target && !taken) {
      const site = siteOf(target);
      this.deps.audit.append({
        botId,
        kind: "browser.user_opened",
        summary: "User opened an address in the Bot browser",
        detail: { actor: "user", ...(site ? { domain: site.slice(0, 200) } : {}) },
      });
      this.deps.session?.userOpened(botId, plain(target, 2048));
    }
    return this.publish(botId, view);
  }

  /** The sleeping view was clicked; the remembered tabs come back in order. */
  async wake(botId: string) {
    await this.rules(botId);
    const view = await this.host.wake(botId);
    this.touch(botId);
    return this.publish(botId, view);
  }

  /** "+" in the tab strip. */
  async newTab(botId: string) {
    await this.rules(botId);
    const view = await this.host.newTab(botId);
    this.touch(botId);
    return this.publish(botId, view);
  }

  async clearData(botId: string) {
    await this.host.clearData(botId);
    this.deps.session?.forgetPage(botId);
    this.deps.audit.append({
      botId,
      kind: "browser.data_cleared",
      summary: "Bot browser data cleared",
      detail: { actor: "user" },
    });
    return this.publish(botId, await this.host.state(botId));
  }

  async input(botId: string, tabId: string, event: BrowserInputEvent, actor?: BrowserRemoteActor) {
    if (actor) this.assertPhoneOwner(botId, actor);
    await this.host.input(botId, hostTab(tabId), toHostInput(event));
  }

  /** A phone acts on the page only during its own takeover. */
  private assertPhoneOwner(botId: string, actor: BrowserRemoteActor) {
    const taken = this.takeovers.get(botId);
    if (!taken) throw new RpcError(RpcErrorCodes.busy, "browser_not_taken_over");
    if (taken.actor?.deviceId !== actor.deviceId) throw elsewhere();
  }

  /**
   * A phone takes over or hands back. It never takes the browser from the desktop user,
   * another phone or a teaching recording, and only hands back its own takeover; the page stays
   * hidden on the computer (no takeover window jumping in front of whoever sits there).
   */
  async remoteTakeover(
    botId: string,
    on: boolean,
    actor: BrowserRemoteActor,
    conversationId?: string,
  ) {
    const taken = this.takeovers.get(botId);
    if (on) {
      if (taken?.actor?.deviceId === actor.deviceId) return this.state(botId);
      const view = await this.host.state(botId);
      if (taken || view.takeover || view.recording) throw elsewhere();
      return this.takeover(botId, true, conversationId, actor);
    }
    // Already handed back (from the computer, or the pages closed): nothing left to do.
    if (!taken) return this.state(botId);
    if (taken.actor?.deviceId !== actor.deviceId) throw elsewhere();
    return this.takeover(botId, false, undefined, actor);
  }

  /** The phone's next frame of the shared screencast, with the current state. */
  async remoteFrame(
    botId: string,
    after: number,
    signal: AbortSignal,
    actor: BrowserRemoteActor,
  ): Promise<BrowserRemoteView> {
    const host = this.host;
    if (!host.remoteFrame) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    const { view, frame } = await host.remoteFrame(botId, after, REMOTE_WAIT_MS, signal);
    return {
      state: this.publish(botId, view),
      frame: frame
        ? {
            seq: frame.seq,
            tabId: frame.tab,
            width: frame.width,
            height: frame.height,
            data: frame.data,
          }
        : null,
      mine: view.takeover && this.takeovers.get(botId)?.actor?.deviceId === actor.deviceId,
    };
  }

  async remoteStop(botId: string) {
    await this.host.remoteStop?.(botId);
  }

  async takeover(botId: string, on: boolean, conversationId?: string, actor?: BrowserRemoteActor) {
    const release = on ? this.deps.beginTakeover?.(botId) : undefined;
    try {
      // Taking over sleeping pages reopens them, which needs rules on the host.
      if (on) await this.rules(botId);
      const view = await this.host.takeover(botId, on, actor ? { window: false } : undefined);
      this.touch(botId);
      const existing = this.takeovers.get(botId);
      // The desktop user stepping into a phone takeover makes it theirs: the phone's input stops.
      if (on && !actor && existing?.actor) delete existing.actor;
      if (on && !existing) {
        const place = conversationId ? this.deps.notices?.place(botId, conversationId) : undefined;
        const taken: Takeover = { since: this.deps.now?.() ?? Date.now(), domains: [] };
        if (place) taken.conversationId = place;
        if (actor) taken.actor = actor;
        this.noteSite(taken, view);
        this.takeovers.set(botId, taken);
      }
      if (!on) this.handBack(botId, view);
      return this.publish(botId, view);
    } finally {
      release?.();
    }
  }

  /** Adds the shown page's site; the page the user leaves on always makes the cut. */
  private noteSite(taken: Takeover, view: HostBrowserView, last = false) {
    const site = siteOf(view.tabs.find((tab) => tab.active)?.url ?? "");
    if (!site || taken.domains.includes(site)) return;
    if (taken.domains.length >= MAX_NOTICE_DOMAINS) {
      if (!last) return;
      taken.domains.pop();
    }
    taken.domains.push(site);
  }

  private handBack(botId: string, view: HostBrowserView) {
    const taken = this.takeovers.get(botId);
    if (taken === undefined) return;
    this.takeovers.delete(botId);
    const since = taken.since;
    const url = plain(view.tabs.find((tab) => tab.active)?.url ?? "", 2048);
    // Facts only: how long and which site, never what was typed or clicked.
    let domain: string | undefined;
    try {
      domain = url ? new URL(url).hostname.slice(0, 200) : undefined;
    } catch {
      // A non-URL address has no site to record; the duration alone is still worth keeping.
    }
    const durationMs = Math.max(0, (this.deps.now?.() ?? Date.now()) - since);
    // The host reports where a login form was submitted (hostnames, validated by the
    // host protocol); the account itself never leaves the host's pending capture.
    const signedIn = view.signedIn ?? [];
    this.deps.audit.append({
      botId,
      kind: "browser.takeover",
      summary: taken.actor
        ? "User took over the Bot browser from a phone"
        : "User took over the Bot browser",
      detail: {
        ...(taken.actor ? { actor: "phone", deviceId: taken.actor.deviceId } : { actor: "user" }),
        durationMs,
        ...(domain ? { domain } : {}),
        ...(signedIn.length ? { signedIn } : {}),
      },
    });
    // Manual and automatic hand-backs both arrive here, so both leave the chat line.
    if (taken.conversationId) {
      this.noteSite(taken, view, true);
      this.deps.notices?.browserHandBack({
        botId,
        conversationId: taken.conversationId,
        durationMs,
        domains: taken.domains,
        ...(signedIn.length ? { signedIn } : {}),
      });
    }
    // A tool call waiting out the takeover notices on its next poll (every 2 s); the session
    // also gets the new page for policy and tells the Bot once on its next browser result.
    this.deps.session?.handBack(botId, url);
  }

  /**
   * Called by the tools' session whenever a Bot's page changes, so the side pane can appear
   * and the title bar shows "browser in use". Coalesced per Bot; failures are only logged.
   */
  changed(botId: string, groupId?: string) {
    if (groupId) {
      this.scoped(botId, groupId).changed(botId);
      return;
    }
    this.touch(botId);
    if (this.timers.has(botId) || this.disposed || !this.deps.host) return;
    this.timers.set(
      botId,
      setTimeout(() => {
        this.timers.delete(botId);
        const work = this.state(botId).catch(() =>
          this.deps.logger.warn(`browser.state refresh failed botId=${botId}`),
        );
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
      }, EMIT_THROTTLE_MS),
    );
  }

  async dispose() {
    this.disposed = true;
    this.lifetime.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.groupViews.values()].map((view) => view.dispose()));
    this.groupViews.clear();
    await Promise.allSettled([...this.pending]);
  }
}

/** Registered through brain's single RPC wrapper (validation, redacted logging, error mapping). */
export function registerBrowserRpc(handle: RegisterRpc, browser: BrowserViewService) {
  handle("browser.tabs", ({ botId, groupId }) => browser.scoped(botId, groupId).state(botId));
  handle("browser.view", ({ botId, groupId, visible, display }) =>
    browser.scoped(botId, groupId).view(botId, visible, display),
  );
  handle("browser.takeover", ({ botId, groupId, on, conversationId }) =>
    browser.scoped(botId, groupId).takeover(botId, on, conversationId),
  );
  handle("browser.switchTab", ({ botId, groupId, tabId }) =>
    browser.scoped(botId, groupId).switchTab(botId, tabId),
  );
  handle("browser.navigate", ({ botId, groupId, tabId, action, url }) =>
    browser.scoped(botId, groupId).navigate(botId, tabId, action, url),
  );
  handle("browser.clearData", (input) =>
    "groupId" in input ? browser.clearGroupData(input.groupId) : browser.clearData(input.botId),
  );
  handle("browser.closeTab", ({ botId, groupId, tabId }) =>
    browser.scoped(botId, groupId).closeTab(botId, tabId),
  );
  handle("browser.wake", ({ botId, groupId }) => browser.scoped(botId, groupId).wake(botId));
  handle("browser.newTab", ({ botId, groupId }) => browser.scoped(botId, groupId).newTab(botId));
  handle("browser.input", async ({ botId, groupId, tabId, event }) => {
    await browser.scoped(botId, groupId).input(botId, tabId, event);
    return { ok: true as const };
  });
}
