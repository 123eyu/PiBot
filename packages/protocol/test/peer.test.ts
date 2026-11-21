import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import type { MethodResults, Peer, Port, Settings } from "../src/index.ts";
import {
  createPeer,
  EventBuffer,
  Events,
  HostMethods,
  Methods,
  RpcError,
  RpcErrorCodes,
} from "../src/index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const info = { version: "0.0.0", platform: "darwin", dataDir: "data", piVersion: "1.0" } as const;
const delta = { runId: id, messageId: id, text: "Hello" };

class MemoryPort implements Port {
  other?: MemoryPort;
  readonly sent: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  post(message: unknown) {
    const snapshot = structuredClone(message);
    this.sent.push(snapshot);
    queueMicrotask(() => this.other?.deliver(snapshot));
  }
  deliver(message: unknown) {
    for (const listener of this.listeners) listener(message);
  }
  onMessage(listener: (message: unknown) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
function ports() {
  const a = new MemoryPort();
  const b = new MemoryPort();
  a.other = b;
  b.other = a;
  return { a, b };
}
const peers: { dispose(): void }[] = [];
function pair(eventBuffer?: EventBuffer<typeof Events>, timeoutMs = 1000) {
  const port = ports();
  const client = createPeer(port.a, { methods: Methods, events: Events, timeoutMs });
  const server = createPeer(port.b, { methods: Methods, events: Events, timeoutMs, eventBuffer });
  peers.push(client, server);
  return { ...port, client, server };
}
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
afterEach(() => {
  for (const peer of peers.splice(0)) peer.dispose();
  vi.useRealTimers();
});

describe("RPC calls", () => {
  it("calls in both directions and infers method/result/event types", async () => {
    const { client, server } = pair();
    server.handle("app.getInfo", async () => info);
    client.handle("providers.remove", async (params) => {
      expectTypeOf(params).toEqualTypeOf<{ providerId: string; auth?: "apiKey" | "cloud" }>();
      return { ok: true };
    });
    const result = client.call("app.getInfo", undefined);
    expectTypeOf(result).toEqualTypeOf<
      Promise<{
        version: string;
        platform: "darwin" | "win32" | "linux";
        dataDir: string;
        piVersion: string;
      }>
    >();
    expect(await result).toEqual(info);
    expect(await server.call("providers.remove", { providerId: "openai" })).toEqual({ ok: true });
    client.on("settings.changed", (payload) => expectTypeOf(payload).toEqualTypeOf<Settings>());
  });
  it("supports custom tables independently of the application schema", async () => {
    const { a, b } = ports();
    const methods = { double: { params: z.strictObject({ n: z.number() }), result: z.number() } };
    const events = { count: z.number() };
    const client = createPeer(a, { methods, events });
    const server = createPeer(b, { methods, events });
    peers.push(client, server);
    server.handle("double", async ({ n }) => n * 2);
    expect(await client.call("double", { n: 4 })).toBe(8);
    const listener = vi.fn();
    client.on("count", listener);
    server.emit("count", 5);
    await flush();
    expect(listener).toHaveBeenCalledWith(5, { seq: 1 });
  });
  it("correlates concurrent calls with out-of-order responses", async () => {
    const { client, server } = pair();
    const resolvers: ((value: MethodResults["app.getInfo"]) => void)[] = [];
    server.handle("app.getInfo", () => new Promise((resolve) => resolvers.push(resolve)));
    const first = client.call("app.getInfo", {});
    const second = client.call("app.getInfo", {});
    await flush();
    resolvers[1]?.({ ...info, version: "second" });
    expect((await second).version).toBe("second");
    resolvers[0]?.(info);
    expect(await first).toEqual(info);
  });
  it("rejects invalid outgoing params before posting and never exposes secret input", async () => {
    const { client, a } = pair();
    await expect(
      client.call("providers.setApiKey", { providerId: "openai", apiKey: "!private-value" }),
    ).rejects.toMatchObject({ code: -32602, message: "Schema validation failed" });
    expect(a.sent).toEqual([]);
  });
  it("returns -32602 for invalid incoming params without executing handler", async () => {
    const { server, a, b } = pair();
    const handler = vi.fn(async () => ({ ok: true as const }));
    server.handle("providers.setApiKey", handler);
    a.post({
      jsonrpc: "2.0",
      id: 0,
      method: "providers.setApiKey",
      params: { providerId: "openai", apiKey: "!private-value" },
    });
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(b.sent).toEqual([
      { jsonrpc: "2.0", id: 0, error: { code: -32602, message: "Schema validation failed" } },
    ]);
    expect(JSON.stringify(b.sent)).not.toContain("private-value");
  });
  it("validates outgoing handler results", async () => {
    const { client, server, b } = pair();
    server.handle("app.getInfo", async () => ({ ...info, secret: "private-value" }) as typeof info);
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({ code: -32603 });
    expect(JSON.stringify(b.sent)).not.toContain("private-value");
  });
  it.each([
    { jsonrpc: "2.0", result: { ...info, platform: "android" } },
    { jsonrpc: "1.0", result: info },
    { jsonrpc: "2.0", result: info, error: { code: -1, message: "both" } },
    { jsonrpc: "2.0" },
    { jsonrpc: "2.0", error: { code: "bad", message: "oops" } },
  ])("validates incoming responses %j", async (response) => {
    const { client, a, b } = pair();
    b.onMessage((request) => {
      const { id: requestId } = request as { id: string };
      b.post({ ...response, id: requestId });
    });
    // Use a port with no peer server so only the crafted response is produced.
    peers.at(-1)?.dispose();
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({ code: -32603 });
    expect(a.sent).toHaveLength(1);
  });
  it("returns -32601 for missing handler, unknown and inherited method names", async () => {
    const { client, a, b } = pair();
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({ code: -32601 });
    for (const method of ["unknown", "toString", "__proto__"]) {
      a.post({ jsonrpc: "2.0", id: method, method });
    }
    await flush();
    expect(b.sent.slice(1)).toEqual(
      ["unknown", "toString", "__proto__"].map((id) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      })),
    );
    await expect(client.call("toString" as keyof typeof Methods, undefined)).rejects.toMatchObject({
      code: -32601,
    });
  });
  it("preserves explicit RPC errors and hides unexpected exception details", async () => {
    const { client, server } = pair();
    server.handle("app.getInfo", async () => {
      throw new RpcError(-32010, "Bot busy");
    });
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({
      code: -32010,
      message: "Bot busy",
    });
    server.handle("app.getInfo", async () => {
      throw new Error("private-value");
    });
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({
      code: -32603,
      message: "Internal error",
    });
  });
  it("returns -32600 for malformed requests", async () => {
    const { a, b } = pair();
    a.post({ jsonrpc: "1.0", id: "bad", method: "app.getInfo" });
    a.post({ jsonrpc: "2.0", id: "bad2", method: 123 });
    a.post([]);
    a.post({});
    await flush();
    expect(b.sent).toEqual(
      ["bad", "bad2", null, null].map((id) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid request" },
      })),
    );
  });
  it("accepts null request IDs as calls rather than notifications", async () => {
    const { a, b, server } = pair();
    server.handle("app.getInfo", async () => info);
    a.post({ jsonrpc: "2.0", id: null, method: "app.getInfo" });
    await flush();
    expect(b.sent).toEqual([{ jsonrpc: "2.0", id: null, result: info }]);
  });
  it("executes valid notifications and never responds to invalid-param notifications", async () => {
    const { a, b, server } = pair();
    const handler = vi.fn(async () => ({ ok: true as const }));
    server.handle("providers.remove", handler);
    a.post({ jsonrpc: "2.0", method: "providers.remove", params: { providerId: "openai" } });
    a.post({ jsonrpc: "2.0", method: "providers.remove", params: { providerId: 123 } });
    a.post({ jsonrpc: "2.0", method: "unknown" });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(b.sent).toEqual([]);
  });
  it("times out, ignores late responses and cancels timers", async () => {
    vi.useFakeTimers();
    const { client, a, b } = pair(undefined, 10);
    peers.at(-1)?.dispose();
    const result = client.call("app.getInfo", undefined);
    const rejected = expect(result).rejects.toMatchObject({ code: RpcErrorCodes.timeout });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    const request = a.sent[0] as { id: string };
    b.post({ jsonrpc: "2.0", id: request.id, result: info });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up when disposed and rejects calls after disposal", async () => {
    vi.useFakeTimers();
    const { client } = pair();
    peers.at(-1)?.dispose();
    const result = client.call("app.getInfo", undefined);
    const rejected = expect(result).rejects.toMatchObject({ code: RpcErrorCodes.closed });
    client.dispose();
    client.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.call("app.getInfo", undefined)).rejects.toMatchObject({
      code: RpcErrorCodes.closed,
    });
    expect(() => client.emit("providers.changed", {})).toThrow(RpcError);
    // Subscribing to a disposed peer is a no-op: it can never deliver, and throwing crashed screens.
    expect(client.on("providers.changed", vi.fn())).toBeTypeOf("function");
    expect(() => client.handle("app.getInfo", async () => info)).toThrow(RpcError);
  });
  it("rejects transport posting failures and clears the timeout", async () => {
    vi.useFakeTimers();
    const { client, a } = pair();
    vi.spyOn(a, "post").mockImplementation(() => {
      throw new Error("Port closed");
    });
    await expect(client.call("app.getInfo", undefined)).rejects.toThrow("Port closed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects invalid options", () => {
    const port = ports().a;
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
      expect(() => createPeer(port, { methods: Methods, events: Events, timeoutMs })).toThrow(
        RangeError,
      );
    for (const capacity of [0, -1, 1.5])
      expect(() => new EventBuffer(Events, capacity)).toThrow(RangeError);
  });
});

describe("events and replay", () => {
  it("does not let an old unsubscribe remove a new subscription", async () => {
    const { client, server } = pair();
    const first = client.on("providers.changed", vi.fn());
    first();
    const listener = vi.fn();
    client.on("providers.changed", listener);
    first();
    server.emit("providers.changed", {});
    await flush();
    expect(listener).toHaveBeenCalledOnce();
  });
  it("increments seq across event names and exposes seq to subscribers", async () => {
    const { server, client, b } = pair();
    const listener = vi.fn();
    client.on("chat.delta", listener);
    server.emit("chat.delta", delta);
    server.emit("providers.changed", {});
    server.emit("chat.delta", { ...delta, text: "World" });
    await flush();
    expect(b.sent).toEqual([
      { jsonrpc: "2.0", method: "chat.delta", params: { seq: 1, payload: delta } },
      { jsonrpc: "2.0", method: "providers.changed", params: { seq: 2, payload: {} } },
      {
        jsonrpc: "2.0",
        method: "chat.delta",
        params: { seq: 3, payload: { ...delta, text: "World" } },
      },
    ]);
    expect(listener.mock.calls.map((call) => call[1])).toEqual([{ seq: 1 }, { seq: 3 }]);
  });
  it("validates emitted and incoming events without advancing seq on validation failure", async () => {
    const { client, server, a, b } = pair();
    const listener = vi.fn();
    client.on("chat.delta", listener);
    expect(() => server.emit("chat.delta", { ...delta, text: 1 } as never)).toThrow(RpcError);
    b.post({
      jsonrpc: "2.0",
      method: "chat.delta",
      params: { seq: 1, payload: { ...delta, text: 1 } },
    });
    b.post({ jsonrpc: "2.0", method: "chat.delta", params: { seq: 0, payload: delta } });
    b.post({
      jsonrpc: "2.0",
      method: "chat.delta",
      params: { seq: 1, payload: delta, extra: true },
    });
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(a.sent).toEqual([]);
    server.emit("chat.delta", delta);
    await flush();
    expect(listener).toHaveBeenCalledWith(delta, { seq: 1 });
  });
  it("isolates throwing subscribers and makes unsubscribe idempotent", async () => {
    const { client, server } = pair();
    client.on("providers.changed", () => {
      throw new Error("Subscriber failed");
    });
    const listener = vi.fn();
    const unsubscribe = client.on("providers.changed", listener);
    server.emit("providers.changed", {});
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    server.emit("providers.changed", {});
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("returns only events strictly after afterSeq, preserving payload, order and seq", async () => {
    const { client, server } = pair();
    const listener = vi.fn();
    client.on("chat.delta", listener);
    server.emit("chat.delta", delta);
    server.emit("providers.changed", {});
    server.emit("chat.done", { runId: id, messageId: id, stopReason: "stop" });
    const result = await client.call("events.resume", { afterSeq: 1 });
    expect(result).toEqual([
      { jsonrpc: "2.0", method: "providers.changed", params: { seq: 2, payload: {} } },
      {
        jsonrpc: "2.0",
        method: "chat.done",
        params: { seq: 3, payload: { runId: id, messageId: id, stopReason: "stop" } },
      },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await client.call("events.resume", { afterSeq: 3 })).toEqual([]);
    expect(await client.call("events.resume", { afterSeq: 0 })).toHaveLength(3);
    expect(() => server.handle("events.resume", async () => [])).toThrow("managed by the peer");
  });
  it("preserves event history across replacement ports with an explicitly retained buffer", async () => {
    const buffer = new EventBuffer(Events);
    const first = pair(buffer);
    first.server.emit("chat.delta", delta);
    first.server.dispose();
    first.client.dispose();
    const second = pair(buffer);
    second.server.emit("providers.changed", {});
    const events = await second.client.call("events.resume", { afterSeq: 0 });
    expect(events.map((event) => event.params.seq)).toEqual([1, 2]);
    expect(events[0]?.params.payload).toEqual(delta);
  });
  it("rejects expired/future cursors, so consumers know to reload state", async () => {
    const { client, server } = pair(new EventBuffer(Events, 2));
    server.emit("providers.changed", {});
    server.emit("providers.changed", {});
    server.emit("providers.changed", {});
    await expect(client.call("events.resume", { afterSeq: 0 })).rejects.toMatchObject({
      code: RpcErrorCodes.resumeUnavailable,
    });
    await expect(client.call("events.resume", { afterSeq: 4 })).rejects.toMatchObject({
      code: RpcErrorCodes.resumeUnavailable,
    });
    await expect(client.call("events.resume", { afterSeq: -1 })).rejects.toMatchObject({
      code: -32602,
    });
    expect(
      (await client.call("events.resume", { afterSeq: 1 })).map((event) => event.params.seq),
    ).toEqual([2, 3]);
  });
  it("snapshots history against mutation of original and replayed payloads", async () => {
    const { client, server } = pair();
    const payload = { runId: id, messageId: id, usage: { count: 1 }, stopReason: "stop" };
    server.emit("chat.done", payload);
    payload.usage.count = 100;
    const first = await client.call("events.resume", { afterSeq: 0 });
    expect(first[0]?.params.payload).toEqual({ ...payload, usage: { count: 1 } });
    if (first[0]?.method === "chat.done") first[0].params.payload.stopReason = "changed";
    const second = await client.call("events.resume", { afterSeq: 0 });
    expect(second[0]?.params.payload).toEqual({ ...payload, usage: { count: 1 } });
  });
  it("retains an event even if delivery fails, allowing recovery", async () => {
    const { client, server, b } = pair();
    const spy = vi.spyOn(b, "post").mockImplementationOnce(() => {
      throw new Error("Disconnected");
    });
    expect(() => server.emit("chat.delta", delta)).toThrow("Disconnected");
    spy.mockRestore();
    expect((await client.call("events.resume", { afterSeq: 0 }))[0]?.params).toEqual({
      seq: 1,
      payload: delta,
    });
  });
  it("returns an empty replay before any events exist", async () => {
    const { client } = pair();
    expect(await client.call("events.resume", { afterSeq: 0 })).toEqual([]);
    await expect(client.call("events.resume", { afterSeq: 1 })).rejects.toMatchObject({
      code: RpcErrorCodes.resumeUnavailable,
    });
  });
});

it("runs HostMethods over a separate port with structured-clone binary data", async () => {
  const { a, b } = ports();
  const brain = createPeer(a, { methods: HostMethods, events: {} });
  const main = createPeer(b, { methods: HostMethods, events: {} });
  peers.push(brain, main);
  main.handle("host.secrets.isAvailable", async () => true);
  main.handle("host.secrets.encrypt", async ({ plain }) => new TextEncoder().encode(plain));
  main.handle("host.secrets.decrypt", async ({ cipher }) => new TextDecoder().decode(cipher));
  main.handle("host.env.detect", async () => ["OPENAI_API_KEY"]);
  main.handle("host.env.read", async () => null);
  main.handle("host.openExternal", async () => null);
  main.handle("host.setLoginItem", async () => null);
  expect(await brain.call("host.secrets.isAvailable", {})).toBe(true);
  const cipher = await brain.call("host.secrets.encrypt", { plain: "fake-key" });
  expect(cipher).toBeInstanceOf(Uint8Array);
  expect(await brain.call("host.secrets.decrypt", { cipher })).toBe("fake-key");
  expect(await brain.call("host.env.detect", undefined)).toEqual(["OPENAI_API_KEY"]);
  expect(await brain.call("host.env.read", { name: "MISSING_KEY" })).toBeNull();
  expect(await brain.call("host.openExternal", { url: "https://example.com" })).toBeNull();
  expect(await brain.call("host.setLoginItem", { openAtLogin: true })).toBeNull();
});

// Keep the public generic contract checked independently of createPeer inference.
expectTypeOf<Peer<typeof Methods, typeof Events>>().toHaveProperty("call");
