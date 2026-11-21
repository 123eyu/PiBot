import assert from "node:assert/strict";

// The losing LAN branch opens but never answers Noise or acknowledges close, as on a dead VPN.
export function attachRecoverySockets(phone, Socket, owners, stats) {
  const native = new Map();
  const closes = new Map();
  phone.configureNative({
    connect(url, _protocols, _options, id) {
      stats.connects++;
      if (url.startsWith("ws://192.0.2.10:")) {
        stats.lan++;
        native.set(id, {
          send() {},
          close() {
            native.delete(id);
          },
        });
        queueMicrotask(() => phone.emitNative("websocketOpen", { id }));
        return;
      }
      const socket = new Socket(url);
      native.set(id, socket);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => phone.emitNative("websocketOpen", { id }));
      socket.addEventListener("message", ({ data }) =>
        phone.emitNative("websocketMessage", {
          id,
          type: typeof data === "string" ? "text" : "binary",
          data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
        }),
      );
      socket.addEventListener("close", () => native.delete(id));
      socket.addEventListener("error", () => {});
    },
    send: (value, id) => native.get(id).send(value),
    sendBinary: (value, id) => native.get(id).send(Buffer.from(value, "base64")),
    // No websocketClosed receipt, even after the native handle has gone away.
    close(code, reason, id) {
      closes.set(id, (closes.get(id) ?? 0) + 1);
      native.get(id)?.close(code, reason);
    },
  });
  return class extends phone.ProbeWebSocket {
    probeListeners = new Map();
    constructor(url) {
      super(url);
      this.probeLan = url.startsWith("ws://192.0.2.10:");
      this.probeCloseCount = () => closes.get(this._socketId) ?? 0;
      owners.push(this);
    }
    addEventListener(type, listener, ...options) {
      const listeners = this.probeListeners.get(type) ?? new Set();
      this.probeListeners.set(type, listeners);
      listeners.add(listener);
      return super.addEventListener(type, listener, ...options);
    }
    removeEventListener(type, listener, ...options) {
      this.probeListeners.get(type)?.delete(listener);
      return super.removeEventListener(type, listener, ...options);
    }
  };
}

export function recoveryDiscovery(stats) {
  return async (signal, resolved) => {
    stats.scans++;
    stats.active++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stats.active--;
      signal.removeEventListener("abort", close);
    };
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    queueMicrotask(() => {
      if (closed) return;
      resolved({
        name: "1234567890abcdef1234567890abcdef",
        port: 27013,
        addresses: ["192.0.2.10"],
        txt: { v: "1" },
      });
    });
    return close;
  };
}

export function assertRetiredSockets(phone, owners, stats) {
  assert.equal(stats.active, 0, "losing discovery scans must stop before relay is delivered");
  const retired = owners.filter((socket) => socket.readyState !== 1);
  assert.ok(retired.length);
  for (const socket of retired) {
    if (socket.probeLan)
      assert.equal(socket.probeCloseCount(), 2, "LAN close and retirement must each run once");
    assert.equal(socket._subscriptions.length, 0, "retired RN subscriptions must be released");
    for (const [type, listeners] of socket.probeListeners)
      assert.equal(
        // The relay client leaves one no-op "error" sink on a socket it retired, so a late native
        // error cannot surface as unhandled (packages/link socket.ts close()).
        type === "error" && !socket.probeLan ? Math.max(0, listeners.size - 1) : listeners.size,
        0,
        `retired transport listeners must be released (${socket.probeLan ? "lan" : "relay"} ${type})`,
      );
    const state = socket.readyState;
    phone.emitNative("websocketOpen", { id: socket._socketId });
    phone.emitNative("websocketMessage", { id: socket._socketId, type: "text", data: "late" });
    phone.emitNative("websocketClosed", { id: socket._socketId, code: 1000 });
    assert.equal(socket.readyState, state, "late native events must not revive a retired socket");
  }
}
