import type { Bot } from "@pibot/protocol";
import { type ChatReadCache, chatReadCache, disposeChatReads } from "./read-cache.ts";
import { ChatSession } from "./session.ts";
import type { ChatPeer, ChatTarget } from "./types.ts";

export class ChatController {
  setDraftWorkplace: ChatSession["setDraftWorkplace"];
  getSnapshot: ChatSession["getSnapshot"];
  canEvict: ChatSession["canEvict"];
  subscribe: ChatSession["subscribe"];
  start: ChatSession["start"];
  pendingAddition: ChatSession["pendingAddition"];
  restoreAddition: ChatSession["restoreAddition"];
  dispose: ChatSession["dispose"];
  updateBot: ChatSession["updateBot"];
  checkContextHint: ChatSession["checkContextHint"];
  dismissContextHint: ChatSession["dismissContextHint"];
  refreshMetadata: ChatSession["refreshMetadata"];
  reload: ChatSession["reload"];
  retryHistory: ChatSession["retryHistory"];
  loadMore: ChatSession["loadMore"];
  send: ChatSession["send"];
  confirmAppend: ChatSession["confirmAppend"];
  abort: ChatSession["abort"];
  constructor(
    peer: ChatPeer,
    target: ChatTarget = {},
    reads: ChatReadCache = chatReadCache(peer),
    retire?: () => void,
  ) {
    const session = new ChatSession(peer, target, reads, retire);
    this.setDraftWorkplace = session.setDraftWorkplace.bind(session);
    this.getSnapshot = session.getSnapshot.bind(session);
    this.canEvict = session.canEvict.bind(session);
    this.subscribe = session.subscribe.bind(session);
    this.start = session.start.bind(session);
    this.pendingAddition = session.pendingAddition.bind(session);
    this.restoreAddition = session.restoreAddition.bind(session);
    this.dispose = session.dispose.bind(session);
    this.updateBot = session.updateBot.bind(session);
    this.checkContextHint = session.checkContextHint.bind(session);
    this.dismissContextHint = session.dismissContextHint.bind(session);
    this.refreshMetadata = session.refreshMetadata.bind(session);
    this.reload = session.reload.bind(session);
    this.retryHistory = session.retryHistory.bind(session);
    this.loadMore = session.loadMore.bind(session);
    this.send = session.send.bind(session);
    this.confirmAppend = session.confirmAppend.bind(session);
    this.abort = session.abort.bind(session);
  }
}
const controllersKey = Symbol("peer chat controllers");
function controllerMap(peer: ChatPeer): Map<string, ChatController> {
  const owner = peer as ChatPeer & { [controllersKey]?: Map<string, ChatController> };
  if (!owner[controllersKey]) owner[controllersKey] = new Map<string, ChatController>();
  return owner[controllersKey];
}
export function chatController(peer: ChatPeer, target: ChatTarget = {}) {
  const cache = controllerMap(peer);
  const key = JSON.stringify([
    target.botId ?? null,
    target.topicId ?? null,
    target.draftId ?? null,
  ]);
  let controller = cache.get(key);
  if (!controller) {
    // Retain live runs when navigating; idle histories are recoverable from SQLite.
    if (cache.size >= 32)
      for (const [id, existing] of cache) {
        if (existing.canEvict()) {
          existing.dispose();
          cache.delete(id);
          if (cache.size < 32) break;
        }
      }
    controller = new ChatController(peer, target, chatReadCache(peer), () => {
      if (cache.get(key) === controller) cache.delete(key);
    });
    cache.set(key, controller);
  }
  return controller;
}
export function updateChatBots(peer: ChatPeer, bot: Bot) {
  for (const controller of controllerMap(peer).values()) controller.updateBot(bot);
}
export function disposeChatControllers(peer: ChatPeer) {
  for (const controller of controllerMap(peer).values()) controller.dispose();
  controllerMap(peer).clear();
  disposeChatReads(peer);
}
