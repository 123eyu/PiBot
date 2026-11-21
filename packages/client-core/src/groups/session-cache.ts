import type { Bot, Group, Message } from "@pibot/protocol";
import type { ChatPeer } from "../chat/types.ts";
import type { GroupTarget } from "./types.ts";

interface Preview {
  groupId: string;
  expires: number;
  bytes: number;
  count: number;
  value: { group: Group; bots: Bot[] } | { messages: Message[]; hasMore: boolean };
}
const limits = Object.freeze({
  entries: 12,
  messages: 500,
  perConversation: 100,
  bytes: 2_097_152,
  entry: 524_288,
});

/** Workspace-owned previews never substitute for fresh identity or request authorization. */
export class GroupSessionCache {
  private peer?: ChatPeer;
  private entries = new Map<string, Preview>();
  private revision = 0;
  get version() {
    return this.revision;
  }
  bindPeer(peer: ChatPeer | undefined) {
    if (this.peer !== peer) {
      this.clear();
      this.peer = peer;
    }
  }
  clear() {
    this.entries.clear();
    this.revision++;
  }
  invalidateGroup(groupId: string) {
    for (const [key, entry] of this.entries)
      if (entry.groupId === groupId) this.entries.delete(key);
    this.revision++;
  }
  private key(target: GroupTarget) {
    return JSON.stringify([target.groupId, target.conversationId, target.threadId ?? null]);
  }
  invalidateConversation(groupId: string, conversationId?: string, threadId?: string) {
    if (conversationId) this.entries.delete(this.key({ groupId, conversationId, threadId }));
    else this.invalidateGroup(groupId);
    this.revision++;
  }
  private read(peer: ChatPeer, key: string) {
    if (this.peer !== peer) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  readGroup(peer: ChatPeer, groupId: string) {
    const value = this.read(peer, `group:${groupId}`);
    return value && "group" in value ? value : undefined;
  }
  readConversation(peer: ChatPeer, target: GroupTarget) {
    const value = this.read(peer, this.key(target));
    return value && "messages" in value ? value : undefined;
  }
  private put(peer: ChatPeer, key: string, entry: Preview, version: number) {
    if (this.peer !== peer || version !== this.revision) return;
    if (entry.bytes > limits.entry) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    let bytes = 0;
    let count = 0;
    for (const value of this.entries.values()) {
      bytes += value.bytes;
      count += value.count;
    }
    for (const [oldKey, value] of this.entries) {
      if (this.entries.size <= limits.entries && bytes <= limits.bytes && count <= limits.messages)
        break;
      this.entries.delete(oldKey);
      bytes -= value.bytes;
      count -= value.count;
    }
  }
  writeGroup(peer: ChatPeer, group: Group, bots: Bot[], version: number) {
    const value = { group, bots };
    this.put(
      peer,
      `group:${group.id}`,
      {
        groupId: group.id,
        value: structuredClone(value),
        bytes: this.bytes(value),
        count: 0,
        expires: Date.now() + 120_000,
      },
      version,
    );
  }
  writeConversation(
    peer: ChatPeer,
    target: GroupTarget,
    messages: Message[],
    hasMore: boolean,
    version: number,
  ) {
    if (this.peer !== peer || version !== this.revision) return;
    const window: Message[] = [];
    let bytes = 0;
    for (
      let index = messages.length - 1;
      index >= 0 && window.length < limits.perConversation;
      index--
    ) {
      const message = messages[index];
      if (!message || message.conversationId !== target.conversationId) return;
      const size = this.bytes(message);
      if (bytes + size > limits.entry - 128) break;
      bytes += size;
      window.push(message);
    }
    if (!window.length && messages.length) {
      this.entries.delete(this.key(target));
      return;
    }
    const value = {
      messages: window.reverse(),
      hasMore: hasMore || window.length < messages.length,
    };
    this.put(
      peer,
      this.key(target),
      {
        groupId: target.groupId,
        value: structuredClone(value),
        bytes: this.bytes(value),
        count: window.length,
        expires: Date.now() + 120_000,
      },
      version,
    );
  }
  private bytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
}
