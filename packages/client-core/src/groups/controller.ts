import type { ChatPeer } from "../chat/types.ts";
import { GroupSession } from "./session.ts";
import type { GroupSessionCache } from "./session-cache.ts";
import type { GroupTarget } from "./types.ts";

export class GroupConversation {
  getSnapshot: GroupSession["getSnapshot"];
  subscribe: GroupSession["subscribe"];
  start: GroupSession["start"];
  refresh: GroupSession["refresh"];
  more: GroupSession["more"];
  append: GroupSession["append"];
  confirmAppend: GroupSession["confirmAppend"];
  send: GroupSession["send"];
  constructor(
    readonly peer: ChatPeer,
    readonly target: GroupTarget,
    cache?: GroupSessionCache,
  ) {
    const session = new GroupSession(peer, target, cache);
    this.getSnapshot = session.getSnapshot.bind(session);
    this.subscribe = session.subscribe.bind(session);
    this.start = session.start.bind(session);
    this.refresh = session.refresh.bind(session);
    this.more = session.more.bind(session);
    this.append = session.append.bind(session);
    this.confirmAppend = session.confirmAppend.bind(session);
    this.send = session.send.bind(session);
  }
}
