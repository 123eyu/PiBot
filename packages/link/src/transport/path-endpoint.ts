import type { Port } from "@pibot/protocol-base";
import { LinkError } from "../core/bytes.ts";
import type { PathStats } from "./rtc-stats.ts";

export interface LinkWire {
  port: Port;
  closed: AbortSignal;
  close(): Promise<void>;
  /** Diagnostics: a fixed code for why the wire ended (relay_close_1006, peer_left, ...). */
  reason?(): string | undefined;
  pathKind?: "lan" | "punched" | "relay" | "unknown";
  /** A direct wire's selected ICE pair now (rtc-stats.ts); undefined when it cannot tell. */
  stats?(): Promise<PathStats | undefined>;
}
/**
 * How long requests and notifications that reach an endpoint which is about to become the
 * business path wait for it, instead of being refused. Phone test 2026-11-15: the phone selected
 * the relay again and sent `devices.self` right behind its `link.path.fallback`; the computer,
 * still on the dead direct path for a few microtasks, answered `transport_switching`, the phone's
 * rebind failed and the whole session ended (`peer_left`) instead of staying on the healthy
 * relay. Events the computer sent between its own switch and the phone's were dropped the same
 * way.
 */
const HOLD_MS = 3000;
const HOLD_MAX = 32;

/** Counts both directions until a response, including work whose caller already timed out. */
export class PathEndpoint {
  readonly incoming = new Set<string>();
  readonly outgoing = new Set<string>();
  /** Method of each counted request (diagnostics only: why the relay is not idle). */
  private readonly methods = new Map<string, string>();
  frozen = false;
  private chosen = false;
  /** Last inbound message of any kind; the keepalive judges liveness by it. */
  heard = Date.now();
  received = 0;
  /** Business messages this side posted (diagnostics: which direction stopped after a switch). */
  sent = 0;
  /** When this endpoint last became the business path, with the counters at that moment. */
  selectedAt?: number;
  private receivedAtSelect = 0;
  private sentAtSelect = 0;
  /** The ICE pair the probes ran on (opaque stats id: compared, never logged). */
  pair?: string;
  /** Set once the session gave this wire up, with the fixed code why. */
  lost?: string;
  /** Largest pre-switch probe the other side sent here (path-probe.ts); diagnostics only. */
  probed?: "small" | "large";
  get pathKind() {
    return this.wire.pathKind;
  }
  private listeners = new Set<(message: unknown) => void>();
  private queued: unknown[] = [];
  private queuedBytes = 0;
  private held: { raw: unknown; message: Record<string, unknown> }[] = [];
  private holdTimer?: ReturnType<typeof setTimeout>;
  private off: () => void;
  readonly port: Port;

  constructor(
    readonly wire: LinkWire,
    control: (message: Record<string, unknown>) => boolean,
  ) {
    this.off = wire.port.onMessage((raw) => {
      this.heard = Date.now();
      this.received++;
      const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      if (control(m)) return;
      if (this.hold(raw, m)) return;
      this.dispatch(raw, m);
    });
    this.port = {
      post: (raw) => {
        const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const request = typeof m.id === "string" && typeof m.method === "string";
        if (!this.selected || (request && this.frozen)) throw new LinkError("transport_switching");
        if (request) {
          this.outgoing.add(m.id as string);
          this.methods.set(m.id as string, m.method as string);
        }
        try {
          wire.port.post(raw);
          this.sent++;
        } catch (error) {
          if (request) {
            this.outgoing.delete(m.id as string);
            this.methods.delete(m.id as string);
          }
          throw error;
        }
        if (typeof m.id === "string" && !request) {
          this.incoming.delete(m.id);
          this.methods.delete(m.id);
        }
      },
      onMessage: (listener) => {
        this.listeners.add(listener);
        queueMicrotask(() => {
          if (!this.listeners.size) return;
          this.queuedBytes = 0;
          for (const raw of this.queued.splice(0)) for (const fn of this.listeners) fn(raw);
        });
        return () => this.listeners.delete(listener);
      },
      cancelRequest: (id) => wire.port.cancelRequest?.(id),
      onRequestCancel: (listener) => wire.port.onRequestCancel?.(listener) ?? (() => {}),
      sendStream: (message) => wire.port.sendStream?.(message),
      onRequestStream: (listener) => wire.port.onRequestStream?.(listener) ?? (() => {}),
      // A business Peer never owns the standby physical connection.
      dispose() {},
    };
  }

  get selected() {
    return this.chosen;
  }
  set selected(value: boolean) {
    this.chosen = value;
    if (!value) return;
    this.selectedAt = Date.now();
    this.receivedAtSelect = this.received;
    this.sentAtSelect = this.sent;
    this.release();
  }

  /** A request or notification for a business path that is not selected (yet): wait for it. */
  private hold(raw: unknown, m: Record<string, unknown>) {
    // `frozen` only refuses work on the selected path while it drains; a deselected relay keeps
    // the flag from its last switch and must still take a fallback's first requests.
    if (this.chosen || this.lost || this.wire.closed.aborted) return false;
    if (typeof m.method !== "string" || this.held.length >= HOLD_MAX) return false;
    this.held.push({ raw, message: m });
    this.holdTimer ??= setTimeout(() => {
      this.holdTimer = undefined;
      // Never selected: requests get the usual refusal, notifications are dropped as before.
      for (const item of this.held.splice(0)) this.dispatch(item.raw, item.message);
    }, HOLD_MS);
    return true;
  }
  private release() {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    for (const item of this.held.splice(0)) this.dispatch(item.raw, item.message);
  }
  private dispatch(raw: unknown, m: Record<string, unknown>) {
    const wire = this.wire;
    if (typeof m.id === "string" && m.id.length > 0 && m.id.length <= 128) {
      if (typeof m.method === "string") {
        if (!this.selected || this.frozen || this.incoming.has(m.id)) {
          try {
            wire.port.post({
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32000, message: "transport_switching" },
            });
          } catch {
            /* A wire that cannot send is retired by its own close handling. */
          }
          return;
        }
        this.incoming.add(m.id);
        this.methods.set(m.id, m.method);
        if (this.incoming.size > 32) {
          wire.port.dispose?.();
          return;
        }
      } else {
        this.outgoing.delete(m.id);
        this.methods.delete(m.id);
      }
    }
    if (this.selected) {
      if (!this.listeners.size) {
        this.queuedBytes += JSON.stringify(raw).length;
        if (this.queued.length >= 32 || this.queuedBytes > 1_048_576) {
          wire.port.dispose?.();
          return;
        }
        this.queued.push(raw);
      } else for (const listener of this.listeners) listener(raw);
    }
  }

  /** Message counts since this endpoint last became the business path (diagnostics). */
  traffic(now = Date.now()) {
    return {
      ms: this.selectedAt === undefined ? 0 : now - this.selectedAt,
      rx: this.received - this.receivedAtSelect,
      tx: this.sent - this.sentAtSelect,
      quietMs: Math.max(0, now - this.heard),
    };
  }

  idle() {
    return this.incoming.size === 0 && this.outgoing.size === 0;
  }

  /** What keeps the endpoint from being idle: counts and up to 8 method names. */
  busy() {
    const methods = [...new Set(this.methods.values())]
      .filter((name) => /^[A-Za-z][\w.]{0,63}$/.test(name))
      .slice(0, 8);
    return { incoming: this.incoming.size, outgoing: this.outgoing.size, methods };
  }

  async close() {
    this.off();
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.held.length = 0;
    this.listeners.clear();
    this.queued.length = 0;
    await this.wire.close();
  }
}
