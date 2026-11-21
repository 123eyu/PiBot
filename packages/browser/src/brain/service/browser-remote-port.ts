import type { BrowserRemotePort } from "@pibot/browser-contract/full";
import type { BrowserViewService } from "./browser-rpc.ts";

/**
 * The phone remote's way into the same view service the desktop overlay uses. `guard`
 * is the capability's lifetime wrapper (refuses after stop, tracks work for the drain).
 */
export function createBrowserRemotePort(
  view: BrowserViewService,
  guard: <T>(action: () => Promise<T>) => Promise<T>,
): BrowserRemotePort {
  const scoped = (target: { botId: string; groupId?: string }) =>
    view.scoped(target.botId, target.groupId);
  return {
    frame: (target, after, signal, actor) =>
      guard(() => scoped(target).remoteFrame(target.botId, after, signal, actor)),
    stop: (target) => guard(() => scoped(target).remoteStop(target.botId)),
    takeover: (target, actor) =>
      guard(() =>
        scoped(target).remoteTakeover(target.botId, target.on, actor, target.conversationId),
      ),
    input: (target, actor) =>
      guard(() => scoped(target).input(target.botId, target.tabId, target.event, actor)),
    navigate: (target, actor) =>
      guard(() =>
        scoped(target).navigate(target.botId, target.tabId, target.action, target.url, actor),
      ),
  };
}
