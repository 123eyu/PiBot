import type { WindowInfo } from "../core/types.ts";

/**
 * Apps that can never be operated or captured, whatever a grant says (the first list):
 * Pi Bot itself, keychains and password managers, and terminals (commands go through
 * run_command). The removable defaults (chat apps, mail) are user data owned by brain and
 * arrive through the service's `blocked` port. Matching is case-insensitive on the OS app id
 * (bundle id / exe name / app name) or the display name.
 */
const NEVER = [
  // Pi Bot
  "app.pibot.desktop",
  "pi bot",
  "pi bot.exe",
  "pibot",
  // Keychains and password managers
  "com.apple.keychainaccess",
  "keychain access",
  "钥匙串访问",
  "com.apple.passwords",
  "passwords",
  "密码",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "1password",
  "1password.exe",
  "com.bitwarden.desktop",
  "bitwarden",
  "bitwarden.exe",
  "org.keepassxc.keepassxc",
  "keepassxc",
  "keepassxc.exe",
  "keepass.exe",
  "com.dashlane.dashlanephonefinal",
  "dashlane",
  "com.lastpass.lastpass",
  "lastpass",
  "enpass",
  "enpass.exe",
  "credentialuibroker.exe",
  "seahorse",
  "org.gnome.seahorse.application",
  "kwalletmanager5",
  // Terminals
  "com.apple.terminal",
  "terminal",
  "终端",
  "com.googlecode.iterm2",
  "iterm2",
  "dev.warp.warp-stable",
  "warp",
  "net.kovidgoyal.kitty",
  "kitty",
  "org.alacritty",
  "io.alacritty",
  "alacritty",
  "com.github.wez.wezterm",
  "wezterm",
  "co.zeit.hyper",
  "hyper",
  "com.mitchellh.ghostty",
  "ghostty",
  "windowsterminal.exe",
  "wt.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "conhost.exe",
  "openconsole.exe",
  "gnome-terminal",
  "gnome-terminal-server",
  "org.gnome.terminal",
  "org.gnome.console",
  "kgx",
  "konsole",
  "org.kde.konsole",
  "xterm",
  "tilix",
  "terminator",
  "xfce4-terminal",
];
const NEVER_SET = new Set(NEVER);

export function isAlwaysBlocked(app: { id: string; name: string }): boolean {
  return NEVER_SET.has(app.id.toLowerCase()) || NEVER_SET.has(app.name.toLowerCase());
}

const SETTINGS_APPS = new Set([
  "com.apple.systempreferences",
  "com.apple.settings",
  "systemsettings.exe",
  "gnome-control-center",
  "systemsettings",
]);
// The privacy / security page of the system settings: only that page is off limits.
const PRIVACY_TITLE = /privacy|security|隐私|安全/i;

export function isBlockedWindow(app: { id: string }, window: Pick<WindowInfo, "title">): boolean {
  return SETTINGS_APPS.has(app.id.toLowerCase()) && PRIVACY_TITLE.test(window.title);
}

// Menus that act beyond the granted app. The Apple menu (every app's first menu) logs
// out, restarts, force-quits other apps and opens System Settings; Services runs commands of
// other apps (e.g. a new Terminal window, an app that is never operable). Menu titles follow
// the system language, so the common translations are listed.
const APPLE_MENU = /^(apple|苹果|蘋果|)$/i;
const SERVICES_MENU = /^(services|服务|服務|サービス|dienste|servicios|servizi)$/i;

/**
 * Why a menu path may not be pressed in this app, or undefined. Quit / Close / Undo stay
 * allowed: the app's own items do no more than its window controls and shortcuts (keys).
 */
export function menuPathRefusal(
  app: { id: string },
  path: readonly string[],
): { code: "unsupported" | "app_blocked"; detail: string } | undefined {
  const labels = path.map((p) => p.trim());
  if (APPLE_MENU.test(labels[0] ?? ""))
    return { code: "unsupported", detail: "menu_apple_menu_not_allowed" };
  if (labels.some((l) => SERVICES_MENU.test(l)))
    return { code: "unsupported", detail: "menu_services_not_allowed" };
  // Same rule as the privacy window itself, for its menu route (View › Privacy & Security).
  if (SETTINGS_APPS.has(app.id.toLowerCase()) && labels.some((l) => PRIVACY_TITLE.test(l)))
    return { code: "app_blocked", detail: "privacy_settings" };
  return undefined;
}
