import type { SocketConstructor } from "@pibot/link";
import { Methods, RpcError } from "@pibot/protocol";
import { MobileRuntime } from "../runtime/runtime.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";
import { createMobileLink } from "../transport/real-link.ts";
import { createDevLink } from "./fixture-link.ts";

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("scenario_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function runScenario() {
  let checks = 0;
  const check = (value: unknown) => {
    if (!value) throw new Error(`scenario_check_${checks + 1}`);
    checks++;
  };
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>();
  const data: LocalData = {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async removePrefix(prefix) {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    async close() {},
  };
  const secure: SecretData = {
    async get(id) {
      return secrets.get(id) ?? null;
    },
    async set(id, value) {
      secrets.set(id, value);
    },
    async remove(id) {
      secrets.delete(id);
    },
  };
  const fixture = createDevLink(),
    storage = new MobileStorage(data, secure, memoryBlobFiles()),
    runtime = new MobileRuntime(storage, fixture.link, 0);
  try {
    await runtime.initialize();
    check(runtime.getSnapshot().devices.length === 0);
    const candidate = await runtime.preparePair("development-qr", fixture.computer.name);
    check(candidate.safetyCode === "123456");
    check(runtime.getSnapshot().devices.length === 0);
    await runtime.savePair();
    await waitFor(() => runtime.getSnapshot().status === "online");
    check(!JSON.stringify(runtime.getSnapshot()).includes("OPAQUE"));
    const target = { botId: fixture.botId, topicId: fixture.topicId };
    await runtime.send(target, "Hello");
    await waitFor(() => runtime.getSnapshot().pending === 0);
    check(fixture.counters.sendCount === 1);
    const history = await runtime.call("chat.history", target);
    check(history.length === 2 && history[1]?.content === "Development reply");
    const runId = history[1]?.runId;
    if (!runId) throw new Error("missing_run");
    await runtime.call("chat.abort", { runId });
    check(fixture.history[1]?.status === "aborted");
    const cards = await runtime.call("approvals.pending", { limit: 50 });
    check(cards.length === 1);
    const card = cards[0];
    if (!card) throw new Error("missing_card");
    await runtime.call("approvals.resolve", {
      id: card.id,
      decision: "deny",
      remember: false,
    });
    check((await runtime.call("approvals.pending", {})).length === 0);
    await runtime.registerPush("ExpoPushToken[DEVELOPMENT_ONLY]", "en", candidate.id);
    check(fixture.counters.pushCount === 1);
    await runtime.setForeground(false);
    check(fixture.counters.connections === 0);
    await runtime.send(target, "Send when foreground");
    check(runtime.getSnapshot().pending === 1);
    let refused = false;
    try {
      await runtime.call("chat.abort", { runId });
    } catch {
      refused = true;
    }
    check(refused);
    await runtime.setForeground(true);
    await waitFor(() => runtime.getSnapshot().pending === 0);
    check(fixture.counters.sendCount === 2);
    fixture.loseNextReceipt();
    await runtime.send(target, "Receipt may be lost");
    await waitFor(() => runtime.getSnapshot().error === "uncertain");
    check(runtime.getSnapshot().pending === 1);
    const retained = (await storage.outbox(candidate.id))[0]?.clientId;
    await runtime.select(candidate.id);
    await waitFor(() => runtime.getSnapshot().pending === 0);
    check(fixture.counters.sendCount === 3 && !!retained);
    await storage.cacheHistory(candidate.id, JSON.stringify(target), fixture.history);
    check((await storage.history(candidate.id, JSON.stringify(target))).length === 6);
    let unknown = false;
    try {
      await runtime.call("providers.list", undefined);
    } catch (error) {
      unknown = error instanceof RpcError;
    }
    check(unknown);
    check(Methods["events.resume"].params.safeParse({ afterSeq: 0 }).success);
    fixture.expireReplay();
    await runtime.select(candidate.id);
    await waitFor(() => runtime.getSnapshot().status === "online");
    check(runtime.getSnapshot().peer !== null);
    fixture.restartBrain();
    await runtime.select(candidate.id);
    await waitFor(() => runtime.getSnapshot().status === "online");
    check(runtime.getSnapshot().peer !== null);
    await Promise.all([runtime.send(target, "Burst one"), runtime.send(target, "Burst two")]);
    await waitFor(() => runtime.getSnapshot().pending === 0);
    check(fixture.counters.sendCount === 5);
    await runtime.setForeground(false);
    await runtime.send(target, "Persist across runtime restart");
    const pendingId = (await storage.outbox(candidate.id))[0]?.clientId;
    await runtime.dispose();
    const restarted = new MobileRuntime(storage, fixture.link, 0);
    await restarted.initialize();
    await waitFor(
      () => restarted.getSnapshot().status === "online" && restarted.getSnapshot().pending === 0,
    );
    check(fixture.counters.sendCount === 6 && !!pendingId);
    await restarted.forget(candidate.id);
    check((await storage.computers()).length === 0);
    check(!secrets.has(candidate.id) && (await storage.outbox(candidate.id)).length === 0);
    check([...values.keys()].every((key) => !key.startsWith(`cache:${candidate.id}:`)));
    await restarted.dispose();
    check(fixture.counters.connections === 0);
    const production = new MobileRuntime(
      storage,
      createMobileLink({
        WebSocket: globalThis.WebSocket as unknown as SocketConstructor,
        random: (size) => crypto.getRandomValues(new Uint8Array(size)),
      }),
    );
    let failed = false;
    try {
      await production.preparePair("qr", "phone");
    } catch {
      failed = true;
    }
    check(failed);
    await production.dispose();
    return { checks, transport: "memory-only", networkRequests: 0 };
  } finally {
    await runtime.dispose();
    fixture.disconnect();
  }
}
