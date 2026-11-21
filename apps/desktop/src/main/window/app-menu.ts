import { createTranslator, type Language } from "@pibot/i18n";
import type { UiNavigation } from "@pibot/protocol";
import { Menu } from "electron";

/** Explicit labels follow the UI; no Electron default View menu or reload accelerator. */
export function installAppMenu(
  language: Language,
  navigate: (target: UiNavigation) => void,
  dev: boolean,
  navigationReady = true,
) {
  const t = createTranslator(language);
  const role = (
    name: Electron.MenuItemConstructorOptions["role"],
    key: Parameters<typeof t>[0],
  ): Electron.MenuItemConstructorOptions => ({ role: name, label: t(key) });
  const rows: Electron.MenuItemConstructorOptions[] = [
    {
      label: t("app.name"),
      submenu: [
        {
          label: t("appMenu.about"),
          enabled: navigationReady,
          click: () => navigate({ view: "about" }),
        },
        {
          label: t("appMenu.updates"),
          enabled: navigationReady,
          click: () => navigate({ view: "updates" }),
        },
        {
          label: `${t("settings.title")}…`,
          accelerator: "CmdOrCtrl+,",
          enabled: navigationReady,
          click: () => navigate({ view: "settings" }),
        },
        { type: "separator" },
        ...(process.platform === "darwin"
          ? [
              role("hide", "nativeMenu.hide"),
              role("hideOthers", "nativeMenu.hideOthers"),
              role("unhide", "nativeMenu.showAll"),
            ]
          : []),
        role("quit", "nativeMenu.quit"),
      ],
    },
    {
      label: t("nativeMenu.edit"),
      submenu: [
        role("undo", "nativeMenu.undo"),
        role("redo", "nativeMenu.redo"),
        { type: "separator" },
        role("cut", "nativeMenu.cut"),
        role("copy", "nativeMenu.copy"),
        role("paste", "nativeMenu.paste"),
        role("selectAll", "nativeMenu.selectAll"),
      ],
    },
    {
      label: t("nativeMenu.window"),
      submenu: [
        role("minimize", "nativeMenu.minimize"),
        role("zoom", "nativeMenu.zoom"),
        role("close", "nativeMenu.close"),
      ],
    },
  ];
  // A diagnostic package can expose the local console without changing data or execution mode.
  if (dev || (typeof __PIBOT_DEVTOOLS_BUILD__ !== "undefined" && __PIBOT_DEVTOOLS_BUILD__))
    rows.push({
      label: t("nativeMenu.developer"),
      submenu: [{ role: "toggleDevTools", label: t("nativeMenu.devTools") }],
    });
  Menu.setApplicationMenu(Menu.buildFromTemplate(rows));
}
