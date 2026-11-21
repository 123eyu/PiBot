import { execFile } from "node:child_process";
import type { ComputerStatus } from "@pibot/protocol";

type State = ComputerStatus["permissions"]["automation"];

/**
 * Bots drive other apps with Apple Events through these two (keys, windows, files). Their consent
 * is per target app, so the welcome and settings pages check exactly these.
 */
const TARGETS = ["com.apple.systemevents", "com.apple.finder"] as const;

/*
 * AEDeterminePermissionToAutomateTarget answers without a prompt when askUserIfNeeded is false
 * (0 granted, -1743 denied, -1744 not asked yet, -600 target not running) and shows the system's
 * consent dialog when it is true. osascript runs as Pi Bot's child, so TCC attributes it to
 * Pi Bot. JXA is the system scripting route allowed by the constraints; no native module.
 */
const SCRIPT = `ObjC.import('CoreServices');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
function run(argv) {
  var ask = argv[0] === 'ask';
  return argv.slice(1).map(function (id) {
    var target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id);
    return String($.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, ask));
  }).join(',');
}`;
const NOT_RUNNING = -600;

function run(file: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );
}

async function determine(ask: boolean, timeoutMs: number) {
  const codes = async () =>
    (
      await run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", SCRIPT, ask ? "ask" : "check", ...TARGETS],
        timeoutMs,
      )
    )
      .split(",")
      .map(Number);
  let result = await codes();
  // System Events is a faceless helper that only runs on demand; launching it hidden needs no
  // consent and lets the check answer for it.
  if (result.includes(NOT_RUNNING)) {
    await run("/usr/bin/open", ["-g", "-j", "-b", TARGETS[0]], 5_000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 800));
    result = await codes();
  }
  return result;
}

function state(codes: number[]): State {
  if (codes.length !== TARGETS.length || codes.some((code) => !Number.isFinite(code)))
    return "ask_per_app";
  if (codes.every((code) => code === 0)) return "granted";
  if (codes.includes(-1743)) return "denied";
  if (codes.includes(-1744)) return "not_determined";
  return "ask_per_app";
}

/** Status polls reuse a recent answer; asking always reads afresh. Owner: the computer host. */
export function createMacAutomation(options: { onError(error: unknown): void }) {
  let cached: { at: number; value: State } | undefined;
  let reading: Promise<State> | undefined;
  const status = async (): Promise<State> => {
    if (cached && Date.now() - cached.at < 3_000) return cached.value;
    reading ??= determine(false, 8_000)
      .then(state, (error: unknown) => {
        // An unreadable state keeps the old per-app behaviour instead of blocking anything.
        options.onError(error);
        return "ask_per_app" as const;
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
  /** Shows macOS' consent dialog for targets not asked yet; resolves with the new state. */
  const request = async (): Promise<State> => {
    cached = undefined;
    try {
      const value = state(await determine(true, 120_000));
      cached = { at: Date.now(), value };
      return value;
    } catch (error) {
      options.onError(error);
      return "ask_per_app";
    }
  };
  return { status, request };
}
