import { execFile } from "node:child_process";
import { z } from "zod";

/*
 * Maintainers 2026-11-13: Accessibility and Screen Recording turned off in System Settings still read
 * 已开启. Electron's checks keep the process's first answer (CGPreflightScreenCaptureAccess in
 * particular), so the status the UI asks for is confirmed live by a short JXA probe, the allowed
 * system-script route; osascript runs as Pi Bot's child, so TCC answers for Pi Bot:
 * - Accessibility: one real AX call — kAXErrorAPIDisabled (-25211) means not trusted.
 * - Screen Recording: other apps' window titles are only visible with the permission.
 * Nothing here prompts.
 */
const SCRIPT = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function run() {
  var value = Ref();
  var ax = $.AXUIElementCopyAttributeValue($.AXUIElementCreateSystemWide(), $('AXFocusedApplication'), value);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))) || [];
  var self = $.NSProcessInfo.processInfo.processIdentifier;
  var others = 0, named = 0;
  list.forEach(function (w) {
    if (w.kCGWindowOwnerPID === self || w.kCGWindowLayer !== 0) return;
    others++;
    if (w.kCGWindowName) named++;
  });
  return JSON.stringify({ ax: ax, others: others, named: named });
}`;
const AX_API_DISABLED = -25211;
const ProbeSchema = z.strictObject({
  ax: z.number().int(),
  others: z.number().int().nonnegative(),
  named: z.number().int().nonnegative(),
});

export interface LivePermissions {
  /** False only when the AX call was refused; any other answer means trusted. */
  accessibility: boolean;
  /** Undefined when no other app had a window to tell by; the caller keeps its own answer. */
  screenRecording: boolean | undefined;
}

function probe(timeoutMs: number) {
  return new Promise<LivePermissions>((resolve, reject) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", SCRIPT],
      { timeout: timeoutMs, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(error);
        let raw: unknown;
        try {
          raw = JSON.parse(stdout.trim());
        } catch (parseError) {
          return reject(parseError);
        }
        const parsed = ProbeSchema.safeParse(raw);
        if (!parsed.success) return reject(new Error("permission_probe_invalid"));
        const { ax, others, named } = parsed.data;
        resolve({
          accessibility: ax !== AX_API_DISABLED,
          screenRecording: others === 0 ? undefined : named > 0,
        });
      },
    ),
  );
}

/** UI status reads reuse a recent answer; a failed probe returns undefined (keep the API value). */
export function createMacPermissionProbe(options: { onError(error: unknown): void }) {
  let cached: { at: number; value: LivePermissions | undefined } | undefined;
  let reading: Promise<LivePermissions | undefined> | undefined;
  return async (): Promise<LivePermissions | undefined> => {
    if (cached && Date.now() - cached.at < 3_000) return cached.value;
    reading ??= probe(5_000)
      .catch((error: unknown) => {
        options.onError(error);
        return undefined;
      })
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
}
