import type { BackgroundWire } from "@pibot/protocol/background";
import { type LaunchProgress, launchBackground } from "./background-launch.ts";
import { createWindowsBackgroundSecurity } from "./windows-background-security.ts";

type Options = Parameters<typeof launchBackground>[0];
/** Starts the authenticated connection before app ready; the GUI takes ownership once created. */
export function prelaunchBackground(
  options: Omit<Options, "receive" | "closed" | "progress" | "logger">,
) {
  let receiver: Options["receive"] | undefined;
  let onClose: Options["closed"] | undefined;
  let progress: Options["progress"];
  let logger: Options["logger"] | undefined;
  const diagnostics: string[] = [];
  const milestones: [LaunchProgress, number][] = [];
  // Messages that arrive before the GUI adopts the connection (e.g. a settings broadcast) are
  // replayed on take; bounded so a misbehaving owner cannot grow it without limit.
  const early: BackgroundWire[] = [];
  let closed = false;
  let taking = false;
  let taken = false;
  let disposed = false;
  let connected: Awaited<ReturnType<typeof launchBackground>> | undefined;
  const abort = new AbortController();
  // Settles at the launcher's first decision (spawned, connected, waiting for a retiring owner,
  // retry) or when it ends. Until then its descriptor IO shares this thread with the GUI's own
  // window graph, which used to push the owner spawn back by 0.5-0.9 s.
  let settleDecided: () => void = () => {};
  const decided = new Promise<void>((resolve) => {
    settleDecided = resolve;
  });
  // The entry starts before its Logger exists; only fixed security facts enter this queue.
  const queuedLogger = {
    warn: (message: string) => {
      if (logger) logger.warn(message);
      else if (!disposed && diagnostics.length < 32) diagnostics.push(message);
    },
  };
  // Shared with the GUI client after take: one warm PowerShell per GUI process, not two cold
  // starts racing on a busy machine (Windows VM acceptance 2026-11-11).
  const windows =
    process.platform === "win32"
      ? createWindowsBackgroundSecurity({
          systemRoot: options.env.SystemRoot ?? options.env.SYSTEMROOT,
          executable: options.owner.file,
          logger: queuedLogger,
        })
      : undefined;
  const pending = launchBackground({
    ...options,
    windows,
    logger: queuedLogger,
    signal: abort.signal,
    receive: (message: BackgroundWire) => {
      if (receiver) receiver(message);
      else if (early.length < 256) early.push(message);
    },
    closed: () => {
      closed = true;
      onClose?.();
    },
    progress: (event, at = performance.now()) => {
      settleDecided();
      if (progress) progress(event, at);
      else if (milestones.length < 128) milestones.push([event, at]);
    },
  });
  // app ready may fail before the GUI can adopt this operation; never leave a rejection unowned.
  void pending
    .then((connection) => {
      connected = connection;
      if (disposed) connection.close();
    })
    .catch(() => {})
    .finally(settleDecided);
  return {
    decided,
    windows,
    async take(handlers: Pick<Options, "receive" | "closed" | "progress" | "logger">) {
      if (taking || taken || disposed) throw new Error("background_prelaunch_unavailable");
      taking = true;
      logger = handlers.logger;
      for (const diagnostic of diagnostics.splice(0)) logger.warn(diagnostic);
      const connection = await pending;
      for (const [event, at] of milestones) handlers.progress?.(event, at);
      milestones.length = 0;
      if (closed || disposed) {
        connection.close();
        throw new Error("background_prelaunch_disconnected");
      }
      // Only a completed hand-off transfers ownership; until then dispose() can still cancel.
      taken = true;
      receiver = handlers.receive;
      onClose = handlers.closed;
      progress = handlers.progress;
      for (const message of early.splice(0)) handlers.receive(message);
      return connection;
    },
    dispose() {
      // Once adopted the GUI owns its connection, retirement and drain.
      if (taken) return;
      disposed = true;
      settleDecided();
      diagnostics.length = 0;
      abort.abort();
      connected?.close();
    },
  };
}
