// Chromium chooses the Linux credential store from the desktop name. On sessions it does not
// recognise (sway, i3, Hyprland, or an empty XDG_CURRENT_DESKTOP) it silently falls back to
// basic_text, so a running Secret Service (GNOME Keyring, KeePassXC) is never used and Pi Bot
// refuses to save any key (host-rpc treats basic_text as unavailable). Asking for libsecret
// explicitly fixes those sessions; it is what Chromium already picks on GNOME-family desktops.
// KDE keeps Chromium's own KWallet choice. Without a Secret Service the result stays
// "unavailable", exactly as before.
export function linuxPasswordStore(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): "gnome-libsecret" | undefined {
  // An explicit user choice (e.g. --password-store=basic or kwallet6) always wins.
  if (argv.some((arg) => arg.startsWith("--password-store="))) return undefined;
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":");
  const session = (env.DESKTOP_SESSION ?? "").toLowerCase();
  const kde =
    desktops.includes("kde") ||
    Boolean(env.KDE_FULL_SESSION) ||
    session.includes("kde") ||
    session.includes("plasma");
  return kde ? undefined : "gnome-libsecret";
}
