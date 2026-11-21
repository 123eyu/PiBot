import type { BrowserInputEvent, BrowserState } from "@pibot/browser-contract/full";
import {
  BROWSER_FRAME_FPS,
  BROWSER_FRAME_FPS_NARROW,
  browserBlockedReason,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import { botBrowserZh } from "@pibot/browser-contract/i18n";
import { avatarColors, type Peer, useT, WorkspaceContext } from "@pibot/renderer-kit";
import { Button, CloseButton, IconTile } from "@pibot/ui";
import {
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBrowserUiPorts } from "../../shell/ports.tsx";
import { BrowserDebugControls } from "../debug/BrowserDebugControls.tsx";
import { GoogleCompatConfirm } from "../google/GoogleCompatConfirm.tsx";
import { useGoogleCompat } from "../google/use-google-compat.ts";
import { createInputQueue } from "../takeover/input-queue.ts";
import { useTakeoverInput } from "../takeover/use-takeover-input.ts";
import { AddressBar } from "./AddressBar.tsx";
import styles from "./bot-browser.module.css";
import { BrowserIcon } from "./icons.tsx";
import { useBrowserActivity } from "./use-browser-activity.ts";
import { useBrowserFrames } from "./use-browser-frames.ts";
import { useFrameBox } from "./use-frame-box.ts";
import { usePaneVisible } from "./use-pane-visible.ts";

export interface BrowserPaneProps {
  botId: string;
  groupId?: string;
  /** Display name for the title, the hand-back button and status lines. */
  botName: string;
  peer: Peer | null;
  /** Omitted when the container (the side pane header) already offers close / wide. */
  onClose?(): void;
  wide: boolean;
  onToggleWide?(): void;
  /**
   * Fullscreen view: the container lays the pane over the whole chat area (not the sidebar or
   * title bar). Without `onToggleFullscreen` the button is hidden. Taking over no longer asks
   * for fullscreen: the page opens in a window of its own.
   */
  fullscreen?: boolean;
  onToggleFullscreen?(): void;
  /** The Bot is answering right now: status reads "using the browser" instead of "done". */
  running?: boolean;
  /** The chat this pane sits beside: the hand-back record line is written there. */
  conversationId?: string;
  onFeedback?(conversationId: string, text: string): void;
  /** The teach page owns takeover while recording, so no takeover / hand-back button. */
  teaching?: boolean;
}

type Notice =
  | "botBrowser.botActing"
  | "botBrowser.closeTabRecording"
  | "botBrowser.failed"
  | "botBrowser.notTakenOver"
  | "botBrowser.invalidAddress"
  | "botBrowser.unavailable";

function notice(error: unknown): Notice {
  if (!(error instanceof RpcError)) return "botBrowser.failed";
  if (error.code === RpcErrorCodes.unsupported) return "botBrowser.unavailable";
  if (error.message === "browser_not_taken_over") return "botBrowser.notTakenOver";
  if (error.message === "browser_unsupported_url") return "botBrowser.invalidAddress";
  if (error.message === "browser_recording_last_tab") return "botBrowser.closeTabRecording";
  if (error.message === "browser_bot_acting") return "botBrowser.botActing";
  return "botBrowser.failed";
}

/** Input aimed at a tab that is no longer there (its page closed it, the user did, a crash). */
const TAB_GONE = new Set([
  "browser_tab_closed",
  "browser_tab_closed_by_user",
  "browser_tab_not_shown",
  "browser_tab_not_found",
  "browser_pages_closed_open_again",
]);
function tabGone(error: unknown) {
  return (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.closed || TAB_GONE.has(error.message))
  );
}

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The Bot browser view (design「Bot 浏览器」): a live screencast with tabs, address
 * bar and takeover. It fills whatever container mounts it; the side pane owns placement,
 * width and opening/closing. Frames come over the dedicated port, never the business RPC.
 */
/**
 * The pane sits beside the chat, not inside it, so it sets the chat's colour pair itself;
 * the account cards it hosts (fill, save prompt) read `--chat-c` / `--chat-ink` like chat cards.
 * A group's chat is teal, the same rule as the chat column.
 */
function paneColor(groupId: string | undefined, avatarColor: string | undefined): CSSProperties {
  const color = groupId ? "teal" : (avatarColors.find((c) => c === avatarColor) ?? "violet");
  return {
    "--chat-c": `var(--avatar-${color})`,
    "--chat-ink": `var(--ink-${color})`,
  } as CSSProperties;
}

export function BrowserPane({
  botId,
  groupId,
  botName,
  peer,
  onClose,
  wide,
  onToggleWide,
  fullscreen = false,
  onToggleFullscreen,
  running = false,
  conversationId,
  onFeedback,
  teaching = false,
}: BrowserPaneProps) {
  const { SaveLoginPrompt, TakeoverAccounts } = useBrowserUiPorts();
  const t = useT();
  const workspace = useContext(WorkspaceContext);
  const chatColor = paneColor(
    groupId,
    workspace?.bots.find((bot) => bot.id === botId)?.avatarColor,
  );
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const activity = useBrowserActivity(botId, { running, peer, groupId });
  const { visible, onScreen } = usePaneVisible(root);
  const state = activity.state;
  const open = !!state?.open;
  const takeover = !!state?.takeover;
  const box = useFrameBox(frameBox, open);
  // The narrow sidebar is a glance and gets 2 frames/s; larger or taken-over views get 5.
  const large = wide || fullscreen || takeover;
  const display = useMemo(
    () => box && { ...box, fps: large ? BROWSER_FRAME_FPS : BROWSER_FRAME_FPS_NARROW },
    [box, large],
  );
  const frames = useBrowserFrames({ botId, groupId, peer, want: visible && open, canvas, display });
  // Pages asleep (closed to save memory) still list their tabs, greyed, to restore.
  const sleeping = !open && !!state?.sleeping;
  const tabs = sleeping
    ? (state?.tabs ?? [])
    : ((frames.streaming ? frames.live?.tabs : undefined) ?? state?.tabs ?? []);
  const shown = tabs.find((tab) => tab.active) ?? tabs[0];
  // Google's "this browser may not be secure" page: say why here, since that page only says
  // "try another browser" and the user would otherwise suspect their account or password.
  const googleRefused =
    !sleeping && !!shown && browserBlockedReason(shown.url) === "google_embedded_signin";
  // A page that did not load is Chromium's blank error page: without this the view is just white.
  const loadError = !sleeping && shown && !shown.loading ? shown.error : undefined;
  const [busy, setBusy] = useState(false);
  // The refusal banner offers this Bot's Google compatibility switch, behind a confirm.
  const googleCompat = useGoogleCompat(peer, botId, groupId);
  const [compatConfirm, setCompatConfirm] = useState(false);
  // "+" focuses the address bar of the new blank tab.
  const [focusAddress, setFocusAddress] = useState(0);
  const [error, setError] = useState<Notice | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const run = useCallback(
    async (action: () => Promise<BrowserState>) => {
      setBusy(true);
      setError(null);
      try {
        activity.apply(await action());
        return true;
      } catch (failure) {
        setError(notice(failure));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activity.apply],
  );

  /** The sleeping view, a sleeping tab: reopen the remembered tabs. */
  const wake = () => {
    if (peer) void run(() => peer.call("browser.wake", { botId, ...(groupId ? { groupId } : {}) }));
  };
  /** A blank tab, then the address bar takes the typing. */
  const openBlank = () => {
    if (!peer) return;
    void run(() => peer.call("browser.newTab", { botId, ...(groupId ? { groupId } : {}) })).then(
      (done) => {
        if (done) setFocusAddress((value) => value + 1);
      },
    );
  };

  // The tab and size the user is looking at, read when each input is sent.
  const metaRef = useRef(frames.meta);
  metaRef.current = frames.meta;
  // A tab that went away under the input (e.g. a sign-in popup closing itself): the view moves
  // to the next tab on its own, so this is no failure to show; input to it stops until then.
  const goneTab = useRef<string | null>(null);
  const refresh = activity.refresh;
  const queue = useMemo(() => {
    if (!peer) return undefined;
    return createInputQueue(
      async (event: BrowserInputEvent) => {
        const tabId = metaRef.current?.tabId;
        if (!tabId || tabId === goneTab.current) return;
        try {
          await peer.call("browser.input", {
            botId,
            ...(groupId ? { groupId } : {}),
            tabId,
            event,
          });
        } catch (failure) {
          if (!tabGone(failure)) throw failure;
          goneTab.current = tabId;
          refresh();
        }
      },
      (failure) => setError(notice(failure)),
    );
  }, [peer, botId, groupId, refresh]);
  useEffect(() => () => queue?.close(), [queue]);
  const push = useCallback((event: BrowserInputEvent) => queue?.push(event), [queue]);
  useTakeoverInput({ enabled: takeover, canvas, sink, meta: frames.meta, push });

  useEffect(() => {
    if (!takeover) {
      setSince(null);
      return;
    }
    setSince((value) => value ?? Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [takeover]);

  // Esc leaves fullscreen, except while typing into the taken-over page (Esc belongs to it).
  useEffect(() => {
    if (!fullscreen || !onToggleFullscreen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.activeElement === sink.current) return;
      onToggleFullscreen();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [fullscreen, onToggleFullscreen]);

  // A takeover outside teaching opens the page as an ordinary window of its own, where the
  // user signs in as in any browser; the view here keeps mirroring it (and still takes input).
  // Asking for the takeover again brings that window back to the front.
  const inWindow = takeover && !teaching && !state?.recording;
  const startTakeover = () => {
    if (!peer) return;
    void run(() =>
      peer.call("browser.takeover", {
        botId,
        ...(groupId ? { groupId } : {}),
        on: true,
        ...(conversationId ? { conversationId } : {}),
      }),
    );
  };
  const handBack = () => {
    if (peer)
      void run(() =>
        peer.call("browser.takeover", { botId, ...(groupId ? { groupId } : {}), on: false }),
      );
  };

  // Leaving the view while driving hands the browser back so the Bot carries on instead of
  // waiting out the takeover limit. Closing the pane, another tab and another chat unmount this
  // pane or change its Bot; another page hides it. A minimized or locked window does neither.
  const driving = useRef<{ botId: string; groupId?: string; peer: Peer } | null>(null);
  useEffect(() => {
    driving.current = takeover && peer ? { botId, groupId, peer } : null;
  }, [takeover, botId, groupId, peer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new Bot or peer means the old view was left
  useEffect(
    () => () => {
      const left = driving.current;
      driving.current = null;
      if (left)
        void left.peer
          .call("browser.takeover", {
            botId: left.botId,
            ...(left.groupId ? { groupId: left.groupId } : {}),
            on: false,
          })
          .catch(() => {
            // The pane is gone; the host still ends the takeover when the Bot's wait times out.
          });
    },
    [botId, groupId, peer],
  );
  const handBackRef = useRef(handBack);
  handBackRef.current = handBack;
  const wasOnScreen = useRef(false);
  useEffect(() => {
    // Only the visible → hidden edge counts: a pane mounted mid-takeover is not "leaving".
    const left = wasOnScreen.current && !onScreen;
    wasOnScreen.current = onScreen;
    if (left && takeover) handBackRef.current();
  }, [onScreen, takeover]);

  const takeoverButton = takeover ? (
    <Button
      variant="primary"
      className={`${styles.action} ${styles.handBack}`}
      disabled={busy || !peer}
      onClick={handBack}
    >
      {t("botBrowser.handBack", { name: botName })}
    </Button>
  ) : (
    <Button
      variant="secondary"
      className={styles.action}
      disabled={busy || !peer || !shown}
      onClick={startTakeover}
    >
      <BrowserIcon name="hand" />
      {t("botBrowser.takeover")}
    </Button>
  );

  const tag = takeover
    ? { label: t("botBrowser.youDrive"), className: styles.tagTakeover }
    : frames.streaming
      ? { label: t("botBrowser.live"), className: styles.tagLive }
      : open
        ? { label: t("botBrowser.connecting"), className: styles.tagIdle }
        : null;
  const status = state?.recording
    ? t("botBrowser.statusRecording")
    : running
      ? t("botBrowser.statusWorking", { name: botName })
      : // The pages are already closed; "they close after 10 minutes" would be stale.
        sleeping
        ? t("botBrowser.statusSleeping", { name: botName })
        : t("botBrowser.statusIdle", { name: botName });

  return (
    <section
      ref={root}
      className={`${styles.pane} ${wide || fullscreen ? styles.paneLarge : ""}`}
      style={chatColor}
      aria-label={t("botBrowser.title", { name: botName })}
    >
      <header className={styles.head}>
        <strong className={styles.title}>{t("botBrowser.title", { name: botName })}</strong>
        {tag && (
          <span className={`${styles.tag} ${tag.className}`}>
            <i className={styles.dot} aria-hidden="true" />
            {tag.label}
          </span>
        )}
        <span className={styles.spacer} />
        {fullscreen ? (
          <>
            <span className={styles.escHint}>{t("botBrowser.escHint")}</span>
            <Button variant="ghost" className={styles.mini} onClick={onToggleFullscreen}>
              <BrowserIcon name="shrink" />
              {t("botBrowser.exitFullscreen")}
            </Button>
          </>
        ) : (
          <>
            {onToggleFullscreen && (
              <Button variant="ghost" className={styles.mini} onClick={onToggleFullscreen}>
                <BrowserIcon name="expand" />
                {t("botBrowser.fullscreen")}
              </Button>
            )}
            {onToggleWide && (
              <Button variant="ghost" className={styles.mini} onClick={onToggleWide}>
                <BrowserIcon name={wide ? "shrink" : "expand"} />
                {t(wide ? "botBrowser.narrow" : "botBrowser.wide")}
              </Button>
            )}
            {onClose && <CloseButton label={t("botBrowser.close")} onClick={onClose} />}
          </>
        )}
      </header>
      {!open && !sleeping ? (
        <div className={styles.empty}>
          <IconTile icon="globe" tone="blue" size="lg" className={styles.emptyTile} />
          <strong>{t("botBrowser.emptyTitle", { name: botName })}</strong>
          <span>{t("botBrowser.emptyBody")}</span>
          {!teaching && peer && (
            <Button variant="secondary" disabled={busy} onClick={openBlank}>
              {t("botBrowser.openBlank")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label={t("botBrowser.tabs")}>
            {tabs.map((tab) => {
              const title = noticeTitle(tab.title, t) || t("botBrowser.untitled");
              // While teaching, the recording lives in these pages: keep the last one.
              const keep = !!state?.recording && tabs.length <= 1;
              return (
                <div
                  key={tab.id}
                  role="presentation"
                  className={styles.tabItem}
                  data-active={tab.active || undefined}
                  data-sleeping={sleeping || undefined}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.active}
                    className={styles.tab}
                    title={sleeping ? t("botBrowser.sleepingTab", { title }) : title || tab.url}
                    disabled={busy}
                    onClick={() => {
                      if (!peer) return;
                      if (sleeping) wake();
                      else if (!tab.active)
                        void run(() =>
                          peer.call("browser.switchTab", {
                            botId,
                            ...(groupId ? { groupId } : {}),
                            tabId: tab.id,
                          }),
                        );
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Delete" || keep || !peer) return;
                      event.preventDefault();
                      void run(() =>
                        peer.call("browser.closeTab", {
                          botId,
                          ...(groupId ? { groupId } : {}),
                          tabId: tab.id,
                        }),
                      );
                    }}
                  >
                    <BrowserIcon name="globe" size={14} />
                    <span>{title}</span>
                  </button>
                  {/* The user may close any tab at any time, no takeover needed. */}
                  <button
                    type="button"
                    className={styles.tabClose}
                    aria-label={t("botBrowser.closeTab", { title })}
                    title={
                      keep ? t("botBrowser.closeTabRecording") : t("botBrowser.closeTab", { title })
                    }
                    disabled={busy || keep || !peer}
                    onClick={() => {
                      if (peer)
                        void run(() =>
                          peer.call("browser.closeTab", {
                            botId,
                            ...(groupId ? { groupId } : {}),
                            tabId: tab.id,
                          }),
                        );
                    }}
                  >
                    <BrowserIcon name="close" size={12} />
                  </button>
                </div>
              );
            })}
            {!teaching && (
              <button
                type="button"
                className={styles.tabNew}
                aria-label={t("botBrowser.newTab")}
                title={t("botBrowser.newTab")}
                disabled={busy || !peer}
                onClick={openBlank}
              >
                <BrowserIcon name="plus" size={14} />
              </button>
            )}
          </div>
          <AddressBar
            key={shown?.id ?? "none"}
            url={shown?.url ?? ""}
            editable={!!shown && !!peer && !sleeping}
            focusRequest={focusAddress}
            actions={
              peer && conversationId && !teaching ? (
                <BrowserDebugControls
                  key={`${groupId ?? "dm"}:${botId}:${conversationId}:${shown?.id}`}
                  botId={botId}
                  groupId={groupId}
                  conversationId={conversationId}
                  peer={peer}
                  canvas={canvas}
                  frameBox={frameBox}
                  meta={frames.meta}
                  url={shown?.url ?? ""}
                  disabled={!open || takeover || sleeping || !!state?.recording}
                  diagnosticsDisabled={!open || sleeping || !!state?.recording}
                  onFeedback={onFeedback}
                />
              ) : undefined
            }
            onNavigate={(action, url) => {
              if (peer && shown)
                void run(() =>
                  peer.call("browser.navigate", {
                    botId,
                    ...(groupId ? { groupId } : {}),
                    tabId: shown.id,
                    action,
                    ...(url ? { url } : {}),
                  }),
                );
            }}
          />
          {(takeover || googleRefused) && (
            <div
              className={`${styles.banner} ${googleRefused ? styles.bannerWarn : styles.bannerYou}`}
              role={googleRefused ? "alert" : undefined}
            >
              <BrowserIcon name={googleRefused ? "alert" : "hand"} />
              <span className={styles.bannerText}>
                {googleRefused
                  ? t("botBrowser.googleSigninRefused")
                  : inWindow
                    ? t("botBrowser.takeoverWindowBanner", { name: botName })
                    : t("botBrowser.takeoverBanner", { name: botName })}
              </span>
              {((takeover && !teaching && !state?.recording && peer) || inWindow) && (
                <div className={styles.bannerActions}>
                  {takeover && !teaching && !state?.recording && peer && (
                    <TakeoverAccounts
                      botId={botId}
                      groupId={groupId}
                      peer={peer}
                      pageKey={`${shown?.id}:${shown?.url}`}
                    />
                  )}
                  {inWindow && (
                    <button
                      type="button"
                      className={styles.bannerAction}
                      disabled={busy || !peer}
                      onClick={startTakeover}
                    >
                      {t("botBrowser.showWindow")}
                    </button>
                  )}
                </div>
              )}
              {googleRefused && googleCompat.state && !googleCompat.state.enabled && (
                <button
                  type="button"
                  className={styles.bannerAction}
                  disabled={compatConfirm || !peer}
                  onClick={() => setCompatConfirm(true)}
                >
                  {t("googleCompat.bannerButton")}
                </button>
              )}
            </div>
          )}
          {loadError && shown && (
            <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert">
              <BrowserIcon name="alert" />
              <span className={styles.bannerText}>
                {t(
                  loadError === "ERR_BLOCKED_BY_CLIENT"
                    ? "botBrowser.loadBlocked"
                    : "botBrowser.loadFailed",
                  { error: loadError },
                )}
              </span>
              {peer && (
                <button
                  type="button"
                  className={styles.bannerAction}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      peer.call("browser.navigate", {
                        botId,
                        ...(groupId ? { groupId } : {}),
                        tabId: shown.id,
                        action: "reload",
                      }),
                    )
                  }
                >
                  {t("botBrowser.reloadPage")}
                </button>
              )}
            </div>
          )}
          {googleRefused && compatConfirm && (
            <GoogleCompatConfirm
              name={botName}
              onCancel={() => setCompatConfirm(false)}
              onConfirm={async () => {
                await googleCompat.set(true);
                setCompatConfirm(false);
              }}
            />
          )}
          {sleeping ? (
            <button type="button" className={styles.sleeping} disabled={busy} onClick={wake}>
              <strong>{busy ? t("botBrowser.waking") : t("botBrowser.sleeping")}</strong>
              <span>{t("botBrowser.sleepingBody")}</span>
            </button>
          ) : (
            <div
              ref={frameBox}
              className={`${styles.frame} ${takeover ? styles.frameTakeover : ""}`}
            >
              <canvas
                ref={canvas}
                className={styles.canvas}
                role="img"
                aria-label={t("botBrowser.view", { name: botName })}
                data-takeover={takeover || undefined}
              />
              {!frames.meta && (
                <span className={styles.frameNote}>
                  {visible ? t("botBrowser.waitingFrame") : t("botBrowser.paused")}
                </span>
              )}
              {/* Keyboard and IME sink during takeover; never shown, never logged. */}
              <textarea
                ref={sink}
                className={styles.sink}
                tabIndex={takeover ? 0 : -1}
                aria-hidden="true"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          )}
        </>
      )}
      {/* "Save this account?" after a takeover login (only site and username here). */}
      {!takeover && !groupId && <SaveLoginPrompt botId={botId} />}
      <footer className={styles.foot}>
        {error && (
          <p className={styles.error} role="alert">
            {t(error, { name: botName })}
          </p>
        )}
        {(open || sleeping) && (
          <div className={styles.footRow}>
            <span className={styles.status}>
              {takeover
                ? t("botBrowser.takeoverStatus", {
                    time: elapsed(now - (since ?? now)),
                    name: botName,
                  })
                : status}
            </span>
            {!teaching && takeoverButton}
          </div>
        )}
        <p className={styles.footnote}>{t("botBrowser.footnote")}</p>
      </footer>
    </section>
  );
}

const NOTICE_TITLES = [
  "botBrowser.page.privateTitle",
  "botBrowser.page.notListedTitle",
  "botBrowser.page.failedTitle",
] as const;

/**
 * The refusal page lives in the Bot's own browser, which does not know the app language, so its
 * <title> is the Chinese one (the page body shows both). The tab strip shows it in the app's
 * language instead (docs guide 2026-11-14: the English panel read 已拦截：…).
 */
function noticeTitle(title: string, t: ReturnType<typeof useT>) {
  const key = NOTICE_TITLES.find((candidate) => botBrowserZh[candidate] === title);
  return key ? t(key) : title;
}
