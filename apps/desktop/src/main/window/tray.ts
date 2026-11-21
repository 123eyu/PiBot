import { join } from "node:path";
import { createTranslator, type Language } from "@pibot/i18n";
import type { TrayState } from "@pibot/routines/host";
import { INDEFINITE_PAUSE_UNTIL, isIndefinitePause } from "@pibot/routines-contract";
import { Menu, Notification, nativeImage, nativeTheme, Tray } from "electron";
import {
  type BackgroundPresentation,
  backgroundPreferencesEditable,
  trayStatusKeys,
} from "../../shared/background-presentation.ts";

/** "Until tomorrow morning" means the next local 08:00, which is today's when it is still night. */
function nextMorning(now: Date) {
  const at = new Date(now);
  at.setHours(8, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Tray / menu-bar menu (owner-approved layout of 2026-10-28). The same module serves the macOS
 * menu-bar item of the background owner and the Windows / Linux tray of the embedded desktop;
 * the callers decide what "close window" and "quit completely" mean for their process model.
 */
export function createTray(options: {
  resourcesDir: string;
  language: Language;
  open(): void;
  /** Opens the window on a page that belongs to no single Bot. */
  show(view: "inbox" | "new-chat"): void;
  /** Offered only while closing really leaves routines running; see each caller. */
  closeWindow?: { available(): boolean; run(): void };
  quitAll(): void;
  inbox?: { count(signal: AbortSignal): Promise<number> };
  routines?: {
    pause(until: string): Promise<void>;
    resume(): Promise<void>;
    failed(): void;
  };
}) {
  const t = createTranslator(options.language);
  const locale = options.language === "zh" ? "zh-CN" : "en";
  const image = () => {
    if (process.platform === "darwin") {
      const template = nativeImage.createFromPath(join(options.resourcesDir, "trayTemplate.png"));
      template.setTemplateImage(true);
      return template;
    }
    // Windows uses the coloured logo (maintainers 2026-11-11); Linux panels keep the monochrome pair.
    const variant =
      process.platform === "win32" ? "color" : nativeTheme.shouldUseDarkColors ? "dark" : "light";
    const image = nativeImage.createEmpty();
    for (const size of [16, 24, 32]) {
      const file = join(options.resourcesDir, `tray-${variant}-${size}.png`);
      const png = nativeImage.createFromPath(file);
      image.addRepresentation({ scaleFactor: size / 16, buffer: png.toPNG() });
    }
    return image;
  };
  const tray = new Tray(image());
  tray.setToolTip(t("app.name"));
  let state: TrayState | null = null;
  let activeRuns = 0;
  let background: BackgroundPresentation | null = null;
  let keyringNotice = false;
  let inboxCount = 0;
  let inboxRequest: AbortController | undefined;
  let inboxAgain = false;
  let busy = false,
    destroyed = false;
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (destroyed) return;
    clearTimeout(menuTimer);
    menuTimer = setTimeout(menu, 250);
  };
  const refreshInbox = () => {
    if (destroyed || !options.inbox) return;
    if (inboxRequest) {
      inboxAgain = true;
      return;
    }
    const request = new AbortController();
    inboxRequest = request;
    const timer = setTimeout(() => request.abort(), 5000);
    void options.inbox
      .count(request.signal)
      .then(
        (count) => {
          if (destroyed || count === inboxCount) return;
          inboxCount = count;
          schedule();
        },
        () => {
          // A brain on standby, restarting or stopping cannot answer; the last count stays
          // until it does, and the next inbox change or menu opening asks again.
        },
      )
      .finally(() => {
        clearTimeout(timer);
        inboxRequest = undefined;
        if (inboxAgain && !destroyed) {
          inboxAgain = false;
          refreshInbox();
        }
      });
  };
  const action = (run: () => Promise<void>, paused?: string | null) => {
    if (busy || destroyed || (background && !backgroundPreferencesEditable(background))) return;
    busy = true;
    menu();
    void Promise.resolve()
      .then(run)
      .then(() => {
        // The brain's next tray push confirms this; until then the menu must not offer the
        // action that was just taken.
        if (state && paused !== undefined) state = { ...state, pausedUntil: paused };
      })
      .catch(() => options.routines?.failed())
      .finally(() => {
        busy = false;
        if (!destroyed) menu();
      });
  };
  const pause = (until: string) =>
    action(() => options.routines?.pause(until) ?? Promise.reject(), until);
  const pausedLabel = (until: string) => {
    if (isIndefinitePause(until)) return t("tray.routinesPaused");
    const at = new Date(until);
    const today = new Date().toDateString() === at.toDateString();
    const time = new Intl.DateTimeFormat(locale, {
      ...(today ? {} : { month: "numeric", day: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
    return t("tray.routinesPausedUntil", { time });
  };
  const statusLine = () => {
    const keys = trayStatusKeys(background);
    const words = keys.reason ? t(keys.state, { reason: t(keys.reason) }) : t(keys.state);
    const active = activeRuns;
    if (active === 0) return t("tray.status", { state: words });
    if (active === 1) return t("tray.statusOneTask", { state: words });
    return t("tray.statusTasks", { state: words, count: active });
  };
  function menu() {
    if (destroyed) return;
    const status = statusLine();
    // This is hover text on macOS too, not the menu-bar title. Windows reserves one
    // UTF-16 unit for NUL in szTip; avoid cutting a surrogate pair at the boundary.
    tray.setToolTip(
      process.platform === "win32" && status.length > 127
        ? `${status.slice(0, 126).replace(/[\uD800-\uDBFF]$/, "")}…`
        : status,
    );
    const rows: Electron.MenuItemConstructorOptions[] = [{ label: status, enabled: false }];
    if (keyringNotice) rows.push({ label: t("tray.keyringRestart"), enabled: false });
    if (inboxCount > 0)
      rows.push({
        label: t("tray.waiting", { count: inboxCount }),
        click: () => options.show("inbox"),
      });
    rows.push(
      { type: "separator" },
      { label: t("tray.open"), click: options.open },
      { label: t("tray.newChat"), click: () => options.show("new-chat") },
    );
    const ready = !background || backgroundPreferencesEditable(background);
    if (state && options.routines) {
      const until = state.pausedUntil;
      const paused = until !== null && (isIndefinitePause(until) || Date.parse(until) > Date.now());
      rows.push({ type: "separator" });
      if (paused)
        rows.push({
          label: pausedLabel(until),
          enabled: !busy && ready,
          click: () => action(() => options.routines?.resume() ?? Promise.reject(), null),
        });
      else
        rows.push({
          label: t("tray.routinesPause"),
          enabled: !busy && ready,
          submenu: [
            {
              label: t("tray.routinesPauseHour"),
              click: () => pause(new Date(Date.now() + 3_600_000).toISOString()),
            },
            {
              label: t("tray.routinesPauseMorning"),
              click: () => pause(nextMorning(new Date()).toISOString()),
            },
            {
              label: t("tray.routinesPauseIndefinite"),
              click: () => pause(INDEFINITE_PAUSE_UNTIL),
            },
          ],
        });
    }
    rows.push({ type: "separator" });
    if (options.closeWindow?.available())
      rows.push({ label: t("tray.closeWindow"), click: options.closeWindow.run });
    rows.push({ label: t("tray.quitAll"), click: options.quitAll });
    const built = Menu.buildFromTemplate(rows);
    // Counts follow inbox changes already; this catches anything missed while the brain slept.
    // Not every Linux tray reports the opening, which is why it is not the only source.
    built.on("menu-will-show", refreshInbox);
    tray.setContextMenu(built);
  }
  menu();
  refreshInbox();
  // Native menus own macOS/Linux activation; Windows left clicks need an explicit menu popup.
  if (process.platform === "win32")
    tray.on("click", () => {
      if (!destroyed) tray.popUpContextMenu();
    });
  const update = () => tray.setImage(image());
  nativeTheme.on("updated", update);
  return {
    updateBackground(next: BackgroundPresentation | null) {
      if (destroyed) return;
      background = next ? { lifecycle: next.lifecycle, brainPhase: next.brainPhase } : null;
      schedule();
    },
    updateKeyringNotice(next: boolean) {
      if (destroyed || keyringNotice === next) return;
      keyringNotice = next;
      schedule();
    },
    updateRoutines(next: TrayState | null) {
      if (destroyed) return;
      state = next;
      schedule();
    },
    updateActiveRuns(count: number) {
      if (destroyed || activeRuns === count) return;
      activeRuns = count;
      schedule();
    },
    /** Called on inbox changes and brain readiness; bursts collapse into one count request. */
    refreshInbox() {
      if (destroyed) return;
      clearTimeout(inboxTimer);
      inboxTimer = setTimeout(refreshInbox, 500);
    },
    /** For inputs the tray does not observe itself, such as window visibility. */
    refresh: schedule,
    destroy() {
      destroyed = true;
      clearTimeout(menuTimer);
      clearTimeout(inboxTimer);
      inboxRequest?.abort();
      nativeTheme.off("updated", update);
      tray.destroy();
    },
  };
}

export function notifyBackground(language: Language): boolean {
  if (process.platform === "darwin" || !Notification.isSupported()) return false;
  const t = createTranslator(language);
  new Notification({ title: t("tray.backgroundTitle"), body: t("tray.backgroundBody") }).show();
  return true;
}

/** Once per data directory, when a new install's start-at-sign-in default is applied. */
export function notifyLoginDefault(language: Language): boolean {
  if (!Notification.isSupported()) return false;
  const t = createTranslator(language);
  new Notification({
    title: t("background.loginDefaultTitle"),
    body: t("background.loginDefaultBody"),
  }).show();
  return true;
}

/** Shown once per owner: the tray row stays while the request is current. */
export function notifyKeyringRestart(language: Language): boolean {
  if (!Notification.isSupported()) return false;
  const t = createTranslator(language);
  new Notification({
    title: t("tray.keyringRestartTitle"),
    body: t("tray.keyringRestartBody"),
  }).show();
  return true;
}
