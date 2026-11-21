import { execFile } from "node:child_process";

export type SupportedBrowser = "chrome" | "edge" | "brave" | "chromium" | "firefox";
export type BrowserDetection =
  | { kind: "supported"; browser: SupportedBrowser }
  | { kind: "unsupported"; reason: string; browser?: "safari" | "other" };

function command(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { signal, timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

const fromId = (value: string): BrowserDetection => {
  const id = value.toLowerCase();
  if (id.includes("firefox")) return { kind: "supported", browser: "firefox" };
  if (id.includes("edge")) return { kind: "supported", browser: "edge" };
  if (id.includes("brave")) return { kind: "supported", browser: "brave" };
  if (id.includes("chromium")) return { kind: "supported", browser: "chromium" };
  if (id.includes("chrome")) return { kind: "supported", browser: "chrome" };
  if (id.includes("safari"))
    return { kind: "unsupported", reason: "default_browser_unsupported", browser: "safari" };
  return { kind: "unsupported", reason: "default_browser_unsupported", browser: "other" };
};

/**
 * macOS keeps one handler per scheme in LaunchServices; the https entry names the default
 * browser's bundle id. No https entry means the system default, Safari.
 */
export function macDefaultFromHandlers(handlers: string): string {
  for (const block of handlers.split(/\}\s*,?/))
    if (/LSHandlerURLScheme\s*=\s*"?https"?\s*;/.test(block))
      return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?\s*;/.exec(block)?.[1] ?? "com.apple.safari";
  return "com.apple.safari";
}

export async function detectDefaultBrowser(
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<BrowserDetection> {
  try {
    if (platform === "linux")
      return fromId(await command("xdg-settings", ["get", "default-web-browser"], signal));
    if (platform === "darwin")
      return fromId(
        macDefaultFromHandlers(
          await command(
            "/usr/bin/defaults",
            ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
            signal,
          ).catch(() => ""),
        ),
      );
    if (platform === "win32") {
      const value = await command(
        "reg",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
          "/v",
          "ProgId",
        ],
        signal,
      );
      return fromId(value);
    }
    return { kind: "unsupported", reason: "platform_unsupported" };
  } catch {
    return { kind: "unsupported", reason: "default_browser_detection_failed" };
  }
}
