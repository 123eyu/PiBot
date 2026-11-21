import {
  type Approval,
  createPeer,
  EventBuffer,
  Events,
  type Message,
  Methods,
  type Port,
} from "@pibot/protocol";
import type { Computer, MobileLink, PendingMessage } from "../transport/link-port.ts";
import {
  controlIds,
  controlState,
  gatePort,
  type PhoneGate,
  registerControls,
  type ServerPeer,
} from "./fixture-controls.ts";

/** Explicit, memory-only development fixture. No production module imports this file. */
function ports() {
  const a = new Set<(m: unknown) => void>(),
    b = new Set<(m: unknown) => void>();
  let closed = false;
  const port = (own: Set<(m: unknown) => void>, other: Set<(m: unknown) => void>): Port => ({
    post(message) {
      const value = structuredClone(message);
      queueMicrotask(() => {
        if (!closed) for (const receive of other) receive(value);
      });
    },
    onMessage(fn) {
      own.add(fn);
      return () => {
        own.delete(fn);
      };
    },
    dispose() {
      closed = true;
      a.clear();
      b.clear();
    },
  });
  return { client: port(a, b), server: port(b, a) };
}
export function createDevLink(gate?: PhoneGate, register?: (server: ServerPeer) => void) {
  const computer: Computer = {
    id: crypto.randomUUID(),
    name: "Development computer",
    relay: "wss://invalid.example",
    publicKey: "development-public-key",
    safetyCode: "123456",
  };
  const botId = crypto.randomUUID(),
    topicId = crypto.randomUUID(),
    initialEpoch = crypto.randomUUID();
  let epoch = initialEpoch;
  const buffer = new EventBuffer(Events);
  const history: Message[] = [];
  const receipts = new Map<
    string,
    Awaited<ReturnType<import("../transport/link-port.ts").LinkConnection["send"]>>
  >();
  const now = () => new Date().toISOString();
  const approval: Approval = {
    id: crypto.randomUUID(),
    botId,
    runId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    toolCallId: "dev-tool",
    conversationId: topicId,
    category: "run_command",
    risk: "danger",
    title: "Development approval",
    facts: [{ kind: "warning", value: "force_push", risk: "danger" }],
    canRemember: true,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    isolation: { available: true },
    status: "pending",
    remembered: false,
    createdAt: now(),
    resolvedAt: null,
  };
  let online = true,
    loseReceipt = false,
    closedCount = 0,
    sendCount = 0,
    pushCount = 0;
  const calls: string[] = [];
  const frames: number[] = [];
  const ids = controlIds(botId, topicId),
    controls = controlState(ids);
  const peers = new Set<ReturnType<typeof createPeer<typeof Methods, typeof Events>>>();
  const closers = new Set<() => void>();
  const link: MobileLink = {
    async pair(_qr, name, signal) {
      signal.throwIfAborted();
      // The runtime parses stored LAN routing hints even for this in-memory connection.
      const testKey = "A".repeat(43);
      return {
        computer: { ...computer, name },
        credential: JSON.stringify({
          version: 1,
          seed: testKey,
          roomKey: testKey,
          publicKey: testKey,
          relay: computer.relay,
        }),
      };
    },
    async connect(_computer, _credential, signal) {
      signal.throwIfAborted();
      if (!online) throw new Error("dev_offline");
      const pair = ports(),
        server = createPeer(gatePort(pair.server, calls, gate, frames), {
          methods: Methods,
          events: Events,
          eventBuffer: buffer,
        });
      peers.add(server);
      registerControls(server, ids, controls);
      register?.(server);
      server.handle("chat.history", async () => history);
      server.handle("approvals.pending", async () =>
        approval.status === "pending" ? [approval] : [],
      );
      server.handle("approvals.resolve", async (p) => {
        if (approval.status !== "pending") throw new Error("already_resolved");
        approval.status = p.decision === "allow" ? "allowed" : "denied";
        approval.remembered = p.remember;
        server.emit("approval.resolved", {
          id: approval.id,
          status: approval.status,
          remembered: approval.remembered,
        });
        return { ok: true };
      });
      server.handle("chat.abort", async ({ runId }) => {
        for (const message of history) if (message.runId === runId) message.status = "aborted";
        return { ok: true };
      });
      server.handle("chat.runs", async () => []);
      server.handle("continuations.list", async () => ({ items: [], nextAfter: null }));
      server.handle("routines.history", async () => []);
      server.handle("routines.pauseAll", async () => ({ ok: true }));
      server.handle("routines.resumeAll", async () => ({ ok: true }));
      const listeners = new Set<() => void>();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        closedCount++;
        peers.delete(server);
        closers.delete(close);
        server.dispose();
        for (const fn of listeners) fn();
        listeners.clear();
      };
      closers.add(close);
      return {
        port: pair.client,
        epoch,
        onClose(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        async close() {
          close();
        },
        async self() {
          return { id: computer.id, name: computer.name };
        },
        async send(message: PendingMessage, requestSignal) {
          requestSignal.throwIfAborted();
          const old = receipts.get(message.clientId);
          if (old) return old;
          const runId = crypto.randomUUID(),
            assistantMessageId = crypto.randomUUID(),
            userMessageId = crypto.randomUUID();
          const base = {
            conversationId: message.target.topicId,
            runId,
            errorCode: null,
            usage: null,
            createdAt: now(),
            updatedAt: now(),
          };
          history.push({
            ...base,
            id: userMessageId,
            role: "user",
            content: message.text,
            status: "done",
          });
          const assistant: Message = {
            ...base,
            id: assistantMessageId,
            botId,
            role: "assistant",
            content: "",
            status: "streaming",
          };
          history.push(assistant);
          sendCount++;
          const route = {
            botId,
            conversationId: message.target.topicId,
            runId,
            messageId: assistantMessageId,
          };
          server.emit("chat.delta", { ...route, text: "Development reply" });
          assistant.content = "Development reply";
          const receipt = {
            runId,
            assistantMessageId,
            userMessageId,
            conversationId: message.target.topicId,
            ...(message.target.groupId ? { groupId: message.target.groupId } : {}),
            ...(message.target.threadId ? { threadId: message.target.threadId } : {}),
          };
          receipts.set(message.clientId, receipt);
          if (loseReceipt) {
            loseReceipt = false;
            throw new Error("dev_ack_lost");
          }
          return receipt;
        },
        async setPushToken(_token, _language, requestSignal) {
          requestSignal.throwIfAborted();
          pushCount++;
        },
        // Runs against the real desktop gateway (probe --phone-data), not this fixture.
        async uploadChunk() {
          throw new Error("dev_share_unavailable");
        },
        async reportPhoneData(_state, requestSignal) {
          requestSignal.throwIfAborted();
        },
        serve: () => () => undefined,
      };
    },
  };
  return {
    link,
    computer,
    botId,
    topicId,
    approval,
    history,
    ids,
    controls,
    /** Every request method the phone sent, in order, including refused ones. */
    calls,
    /** UTF-8 size of every message the fixture computer sent. */
    frames,
    expireReplay() {
      for (let i = 0; i < 1100; i++) buffer.append("inbox.changed", {});
    },
    restartBrain() {
      epoch = crypto.randomUUID();
    },
    disconnect() {
      for (const close of [...closers]) close();
    },
    offline(value: boolean) {
      online = !value;
    },
    loseNextReceipt() {
      loseReceipt = true;
    },
    get counters() {
      return { connections: peers.size, closedCount, sendCount, pushCount };
    },
  };
}
