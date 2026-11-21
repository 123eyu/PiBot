/** Welcome / settings: the proxy this computer already uses, offered as a draft the user saves. */
export const SYSTEM_PROXY_CHANNEL = "pibot:system-proxy";
/** What parseSystemProxy returns; the preload checks main's reply against it. */
export const SYSTEM_PROXY_URL =
  /^https?:\/\/(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]):\d{1,5}$/u;

/**
 * Chromium's answer for one URL ("PROXY 127.0.0.1:7890; DIRECT", "HTTPS proxy.corp:443") to the
 * first HTTP(S) proxy as a URL. SOCKS is skipped: Pi Bot's model proxy only speaks HTTP(S).
 */
export function parseSystemProxy(rules: string): string | null {
  for (const entry of rules.split(";")) {
    const match =
      /^\s*(PROXY|HTTPS|HTTP)\s+([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]):(\d{1,5})\s*$/u.exec(
        entry,
      );
    if (!match) continue;
    const port = Number(match[3]);
    if (port < 1 || port > 65_535) continue;
    return `${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}:${port}`;
  }
  return null;
}
