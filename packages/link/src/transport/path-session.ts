import type { Port } from "@pibot/protocol-base";
import { LinkError } from "../core/bytes.ts";
import { NoiseHandshakeError } from "./handshake.ts";
import { type PathControl, pathClosed, pathDelay, waitFor } from "./path-control.ts";
import { type LinkWire, PathEndpoint } from "./path-endpoint.ts";
import {
  KEEPALIVE_DEAD_MS,
  KEEPALIVE_MS,
  KeepaliveSchema,
  PATH_BYE_REASONS,
  type PathByeReason,
  type PathEvent,
  type PathKind,
} from "./path-keepalive.ts";
import { PathProbes } from "./path-probe.ts";
import { PathSignaling } from "./path-signaling.ts";
import {
  DirectConnectionError,
  type DirectDiagnosticSink,
  type DirectFailure,
  DirectSkipped,
  emitDirectDiagnostic,
} from "./rtc-diagnostics.ts";
import type { PathStats } from "./rtc-stats.ts";
import type { DirectRole } from "./upgrade.ts";

export {
  PATH_BYE_REASONS,
  type PathByeReason,
  type PathEvent,
  type PathKind,
} from "./path-keepalive.ts";

export interface LinkPath {
  port: Port;
  path: "direct" | "relay";
  /** The selected ICE pair of a direct path (same network or through the internet). */
  kind?: PathKind;
  closed: AbortSignal;
}
/**
 * Upgrade retries while the relay carries the session (maintainers 2026-11-13: keep trying direct, on
 * any network). Every attempt runs while the relay stays the business path, so a failed one costs
 * signaling only; the delay grows to 5 minutes and stays there, never to "give up".
 */
const UPGRADE_RETRY_MS = [5000, 30_000, 60_000, 120_000, 300_000] as const;
/**
 * Failures where this side's STUN brought no public candidate (DirectConnectionError.retrySoon)
 * are retried at the shortest delay this many times per session before the backoff grows. Phone
 * test 2026-11-16: after the computer restarted, four such attempts across subnets failed at
 * 5/30/60/120 s gaps and the fifth, 4.5 min in, paired at once with the public candidate.
 */
const QUICK_RETRY_LIMIT = 6;
/**
 * A path that passed the probes and still could not carry the business Peer costs a short outage
 * per switch. After this many in one session it stays on the relay (the phone also pauses direct
 * to that computer for a while, session.ts).
 */
const REBIND_FAILURE_LIMIT = 2;
/** Before probing, wait this long at most for ICE to finish checking the other pairs. */
const SETTLE_MS = 2000;
/** Probe rounds when the selected pair keeps changing; the last passing round decides. */
const PROVE_ROUNDS = 3;
export interface PathSessionOptions {
  relay: LinkWire;
  signal: AbortSignal;
  role: DirectRole;
  reconnect(signal: AbortSignal): Promise<LinkWire>;
  direct?(port: Port, signal: AbortSignal): Promise<LinkWire>;
  onDiagnostic?: DirectDiagnosticSink;
  /** Fixed-code path lifecycle for the owner's log; never addresses or payloads. */
  onEvent?(event: PathEvent): void;
}
/** Owns physical paths; applications own one new business Peer per selected generation. */
export class PathSession {
  private lifetime = new AbortController();
  readonly closed = this.lifetime.signal;
  private relay: PathEndpoint;
  private direct?: PathEndpoint;
  private retired = new Set<PathEndpoint>();
  private generation = new AbortController();
  private selected: PathEndpoint;
  private listeners = new Set<(path: LinkPath) => Promise<void>>();
  private changes = Promise.resolve();
  private tasks = new Set<Promise<unknown>>();
  private signals: PathSignaling;
  private attempt?: AbortController;
  private directAttempt?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private quickRetries = 0;
  private sequence = 0;
  private ready = -1;
  private ack = -1;
  private preparing = false;
  private falling?: Promise<void>;
  private relayAttempt = new AbortController();
  private stop: () => void;
  private closing?: Promise<void>;
  private directFailure?: DirectFailure;
  private failureListeners = new Set<(reason: DirectFailure | undefined) => void>();
  private keepalive?: ReturnType<typeof setInterval>;
  private endCode?: string;
  /** Direct paths failed to carry the business Peer repeatedly; this session no longer upgrades. */
  private directBroken = false;
  private rebindFailures = 0;
  private probes = new PathProbes();
  /** Selected direct endpoints whose direct_traffic line was already written. */
  private reported = new WeakSet<PathEndpoint>();

  constructor(private readonly options: PathSessionOptions) {
    this.stop = () => this.lifetime.abort();
    this.signals = new PathSignaling({
      enabled: () => !!options.direct && !this.direct,
      offer: () => {
        if (options.role === "responder") this.own(this.upgrade());
      },
      control: (message) => {
        this.own(
          this.control(message).catch(() => {
            if (!this.closed.aborted && !this.falling) {
              this.failed("switch_failed");
              emitDirectDiagnostic(this.options.onDiagnostic, {
                event: "failure",
                stage: "switch",
                reason: "switch_failed",
              });
            }
            return this.fallback();
          }),
        );
      },
      fail: () => this.end("signaling_failed"),
    });
    this.relay = this.endpoint(options.relay, true);
    this.selected = this.relay;
    this.selected.selected = true;
    options.signal.addEventListener("abort", this.stop, { once: true });
    this.closed.addEventListener(
      "abort",
      () => {
        this.endCode ??= "closed";
        clearTimeout(this.retry);
        clearInterval(this.keepalive);
        this.attempt?.abort();
        this.relayAttempt.abort();
        this.generation.abort();
        this.probes.dispose();
      },
      { once: true },
    );
    if (options.signal.aborted) this.stop();
    this.own(this.relayLoop().catch(() => this.end("relay_loop_failed")));
  }

  /** Fixed code for why the session ended; undefined while it is open. */
  endReason() {
    return this.closed.aborted ? (this.endCode ?? "closed") : undefined;
  }
  private end(reason: string) {
    this.endCode ??= reason;
    this.stop();
  }
  private event(event: PathEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* A log sink must not interrupt switching or cleanup. */
    }
  }
  private live() {
    return [this.relay, ...(this.direct ? [this.direct] : [])].filter(
      (endpoint) => !endpoint.wire.closed.aborted && !endpoint.lost,
    );
  }
  private sendKeepalive(endpoint: PathEndpoint, params?: { probe?: true; bye?: PathByeReason }) {
    try {
      endpoint.wire.port.post({
        jsonrpc: "2.0",
        method: "link.keepalive",
        ...(params ? { params } : {}),
      });
    } catch {
      /* A wire that cannot send is retired by its own close handling or the next tick. */
    }
  }
  /**
   * Starts the keepalive once both sides are known to understand it: the initiator after the
   * desktop advertised it, the responder on the first keepalive it hears. Older peers never see it.
   */
  enableKeepalive() {
    if (this.keepalive !== undefined || this.closed.aborted) return;
    const now = Date.now();
    // Silence before negotiation says nothing about liveness.
    for (const endpoint of this.live()) endpoint.heard = Math.max(endpoint.heard, now);
    this.keepalive = setInterval(() => {
      if (!this.externalClock) this.tick();
    }, KEEPALIVE_MS);
    this.event({ event: "keepalive_on" });
    for (const endpoint of this.live()) this.sendKeepalive(endpoint);
  }
  private externalClock = false;
  setExternalClock(active: boolean) {
    this.externalClock = active;
  }
  /** Native mobile clock may pulse the same JS owner while frame timers are suspended. */
  pulse() {
    if (this.keepalive !== undefined && !this.closed.aborted) this.tick();
  }
  private tick() {
    const now = Date.now();
    for (const endpoint of this.live()) {
      if (now - endpoint.heard > KEEPALIVE_DEAD_MS) this.lose(endpoint, "heartbeat_timeout");
      else this.sendKeepalive(endpoint);
    }
  }
  /** A selected direct path ends: what crossed it since the switch (path-keepalive.ts). */
  private traffic(endpoint: PathEndpoint, reason: string, stats?: PathStats) {
    if (endpoint === this.relay || !endpoint.selected || endpoint.selectedAt === undefined) return;
    if (this.reported.has(endpoint)) return;
    this.reported.add(endpoint);
    this.event({
      event: "direct_traffic",
      reason,
      ...endpoint.traffic(),
      ...(endpoint.pathKind ? { kind: endpoint.pathKind } : {}),
      ...(stats?.rttMs !== undefined ? { rttMs: stats.rttMs } : {}),
      ...(stats?.pair && endpoint.pair
        ? { pairChanged: stats.pair === endpoint.pair ? 0 : 1 }
        : {}),
    });
  }
  /** The direct wire's ICE pair now; bounded, and undefined when the platform cannot tell. */
  private async stats(endpoint: PathEndpoint, ms = 1000): Promise<PathStats | undefined> {
    if (!endpoint.wire.stats || endpoint.wire.closed.aborted) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        endpoint.wire.stats().catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Gives a dead path up: a direct path falls back to the relay, a dead relay is reopened or ends. */
  private lose(endpoint: PathEndpoint, reason: string, stats?: PathStats) {
    if (endpoint.lost || endpoint.wire.closed.aborted) return;
    this.traffic(endpoint, reason, stats);
    endpoint.lost = reason;
    const relay = endpoint === this.relay;
    this.event({ event: "path_lost", path: relay ? "relay" : "direct", reason });
    if (!relay) {
      this.own(this.fallback());
      return;
    }
    void endpoint.wire.close().catch(() => this.end("drain_unconfirmed"));
  }
  private receiveKeepalive(endpoint: PathEndpoint, message: Record<string, unknown>) {
    const parsed = KeepaliveSchema.safeParse(message);
    if (!parsed.success) return;
    this.enableKeepalive();
    if (parsed.data.params?.probe) this.sendKeepalive(endpoint);
    const bye = parsed.data.params?.bye;
    if (bye !== undefined)
      this.end(`peer_${(PATH_BYE_REASONS as readonly string[]).includes(bye) ? bye : "closed"}`);
  }
  /**
   * After the app was frozen or backgrounded: one round trip on the selected path. No answer
   * within `timeoutMs` gives the path up at once (fallback or end) instead of after the dead timer.
   * True when the path answered, or when liveness cannot be asked (keepalive not negotiated).
   */
  async probe(timeoutMs = 3000) {
    if (this.closed.aborted) return false;
    if (this.keepalive === undefined) return true;
    const endpoint = this.selected;
    const before = endpoint.received;
    this.sendKeepalive(endpoint, { probe: true });
    try {
      await waitFor(
        AbortSignal.any([this.closed, endpoint.wire.closed]),
        () => endpoint.received > before,
        timeoutMs,
      );
      return true;
    } catch {
      if (!this.closed.aborted) this.lose(endpoint, "probe_timeout");
      return false;
    }
  }

  /** Direct paths repeatedly failed to carry the business Peer; this session stays on the relay. */
  broken() {
    return this.directBroken;
  }

  current(): LinkPath {
    const direct = this.selected !== this.relay;
    return {
      port: this.selected.port,
      path: direct ? "direct" : "relay",
      ...(direct && this.selected.pathKind ? { kind: this.selected.pathKind } : {}),
      closed: this.generation.signal,
    };
  }
  onChange(listener: (path: LinkPath) => Promise<void>) {
    this.listeners.add(listener);
    // The first relay Peer must finish identity/resume before upgrades can freeze its calls.
    this.schedule(0);
    return () => this.listeners.delete(listener);
  }
  onDirectFailure(listener: (reason: DirectFailure | undefined) => void) {
    this.failureListeners.add(listener);
    this.notifyFailure(listener);
    return () => this.failureListeners.delete(listener);
  }
  private failed(reason: DirectFailure | undefined) {
    if (reason === this.directFailure || this.closed.aborted) return;
    this.directFailure = reason;
    for (const listener of this.failureListeners) this.notifyFailure(listener);
  }
  private notifyFailure(listener: (reason: DirectFailure | undefined) => void) {
    try {
      listener(this.directFailure);
    } catch {
      /* A status observer must not interrupt switching or resource cleanup. */
    }
  }
  private own<T>(work: Promise<T>) {
    this.tasks.add(work);
    void work.finally(() => this.tasks.delete(work)).catch(() => {});
    return work;
  }
  private endpoint(wire: LinkWire, relay: boolean) {
    const endpoint: PathEndpoint = new PathEndpoint(wire, (message) => {
      if (message.method === "link.keepalive") {
        this.receiveKeepalive(endpoint, message);
        return true;
      }
      if (relay) return this.signals.receive(message);
      if (this.probes.receive(endpoint, message)) return true;
      if (typeof message.method === "string" && message.method.startsWith("link.")) {
        this.end("invalid_control");
        return true;
      }
      return false;
    });
    return endpoint;
  }
  private post(method: PathControl["method"], id: number) {
    this.relay.wire.port.post({ jsonrpc: "2.0", method, params: { id } });
  }
  private activate(endpoint: PathEndpoint, signal = this.closed) {
    const next = this.changes.then(async () => {
      if (signal.aborted || this.closed.aborted || endpoint.wire.closed.aborted)
        throw new LinkError("path_closed");
      if (this.selected === endpoint && !this.generation.signal.aborted) return;
      this.selected.selected = false;
      this.generation.abort();
      this.selected = endpoint;
      endpoint.frozen = false;
      endpoint.selected = true;
      this.generation = new AbortController();
      this.event({
        event: "path_selected",
        path: endpoint === this.relay ? "relay" : "direct",
        ...(endpoint.pathKind ? { kind: endpoint.pathKind } : {}),
      });
      // One echo right at the switch, so `direct_traffic` can tell a path that stopped carrying
      // anything from a peer that did not answer the business Peer (both sides negotiated it).
      if (endpoint !== this.relay && this.keepalive !== undefined)
        this.sendKeepalive(endpoint, { probe: true });
      for (const listener of this.listeners) await listener(this.current());
    });
    this.changes = next.catch(async () => {
      // A retired candidate is an expected upgrade failure, not loss of the healthy relay.
      if (signal.aborted || endpoint.wire.closed.aborted) return;
      if (endpoint === this.relay) {
        this.end("rebind_failed");
        return;
      }
      // A direct path whose business Peer could not bind (v0.0.2 phone test: the channel opened
      // but `devices.self` never answered over it) goes back to the still-open relay. The probes
      // should catch such a path before the switch; one that passed them and still failed is
      // retried at the longest delay, and given up for this session when it happens again.
      if (++this.rebindFailures >= REBIND_FAILURE_LIMIT) this.directBroken = true;
      else this.retries = UPGRADE_RETRY_MS.length - 1;
      // Read the pair before the fallback closes the peer: did ICE move after the probes?
      const stats = await this.stats(endpoint, 500);
      if (signal.aborted || endpoint.wire.closed.aborted) return;
      this.lose(endpoint, "rebind_failed", stats);
    });
    return next;
  }
  private async control(message: PathControl) {
    const id = message.params.id;
    if (message.method === "link.path.fallback") return this.fallback(false);
    if (message.method === "link.path.ready") {
      if (this.options.role !== "initiator" || id !== this.sequence || !this.preparing) return;
      this.ready = id;
      return;
    }
    if (message.method === "link.path.ack") {
      if (this.options.role !== "initiator" || id !== this.sequence || !this.preparing) return;
      this.ack = id;
      return;
    }
    if (this.options.role !== "responder") throw new LinkError("invalid_path_control");
    if (message.method === "link.path.prepare") {
      if (this.preparing) throw new LinkError("invalid_path_control");
      this.preparing = true;
      this.sequence = id;
      this.relay.frozen = true;
      const attempt = this.directAttempt ?? this.attempt;
      if (!attempt) throw new LinkError("path_closed");
      const signal = AbortSignal.any([this.closed, attempt.signal]);
      await this.waitIdle(signal, () => !!this.direct && this.relay.idle());
      signal.throwIfAborted();
      if (!this.preparing || this.sequence !== id) throw new LinkError("path_closed");
      this.post("link.path.ready", id);
      // A lost commit must not leave the business path frozen forever.
      await waitFor(signal, () => !this.preparing);
      return;
    }
    if (!this.preparing || this.sequence !== id || !this.direct || !this.relay.idle())
      throw new LinkError("invalid_path_control");
    const direct = this.direct;
    const signal = AbortSignal.any([this.closed, this.directAttempt?.signal ?? this.closed]);
    // A business Peer that cannot bind is the activation's own failure (it falls back and says
    // why); no ack then, and the other side follows the fallback.
    const bound = await this.activate(direct, signal).then(
      () => true,
      () => false,
    );
    if (!bound) {
      this.preparing = false;
      return;
    }
    signal.throwIfAborted();
    if (this.direct !== direct) throw new LinkError("path_closed");
    this.preparing = false;
    this.post("link.path.ack", id);
  }
  private schedule(ms?: number) {
    if (ms === undefined && this.retry !== undefined) return;
    clearTimeout(this.retry);
    if (
      this.closed.aborted ||
      this.directBroken ||
      !this.options.direct ||
      this.options.role !== "initiator"
    )
      return;
    const delay =
      ms ?? (UPGRADE_RETRY_MS[Math.min(this.retries++, UPGRADE_RETRY_MS.length - 1)] as number);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.own(this.upgrade());
    }, delay);
  }
  private async upgrade() {
    if (
      this.closed.aborted ||
      this.attempt ||
      this.falling ||
      this.direct ||
      !this.options.direct ||
      this.relay.wire.closed.aborted
    )
      return;
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.closed, attempt.signal]);
    const started = Date.now();
    try {
      const wire = await this.options.direct(this.signals.port(this.relay.wire.port), signal);
      this.event({
        event: "direct_ready",
        ms: Date.now() - started,
        ...(wire.pathKind ? { kind: wire.pathKind } : {}),
      });
      if (signal.aborted) {
        await wire.close();
        throw new LinkError("path_closed");
      }
      const direct = this.endpoint(wire, false);
      this.direct = direct;
      this.directAttempt = attempt;
      wire.closed.addEventListener(
        "abort",
        () => {
          if (!this.closed.aborted && !signal.aborted && this.selected === direct) {
            if (!direct.lost) {
              const reason = wire.reason?.() ?? "channel_closed";
              this.traffic(direct, reason);
              this.event({ event: "path_lost", path: "direct", reason });
            }
            this.failed("channel_failed");
            emitDirectDiagnostic(this.options.onDiagnostic, {
              event: "failure",
              stage: "channel",
              reason: "channel_failed",
            });
          }
          this.own(this.fallback());
        },
        { once: true },
      );
      if (wire.closed.aborted) throw new LinkError("path_closed");
      if (this.options.role === "initiator") {
        // Only a peer that negotiated the keepalive is new enough to be probed (an older one ends
        // the session on unknown traffic); its LAN signaling sessions also skip this.
        if (this.keepalive !== undefined) await this.prove(direct, signal);
        const id = ++this.sequence;
        this.preparing = true;
        this.relay.frozen = true;
        this.post("link.path.prepare", id);
        await this.waitIdle(signal, () => this.ready === id && this.relay.idle());
        this.requireDirect(direct, signal);
        this.post("link.path.commit", id);
        await waitFor(signal, () => this.ack === id);
        this.requireDirect(direct, signal);
        const bound = await this.activate(direct, signal).then(
          () => true,
          () => false,
        );
        this.preparing = false;
        // The activation's own failure handling falls back (rebind_failed); nothing to add here.
        if (!bound) return;
        this.requireDirect(direct, signal);
      }
      this.retries = 0;
      this.quickRetries = 0;
      this.failed(undefined);
    } catch (error) {
      if (error instanceof DirectSkipped) {
        // Decided before any offer went out: nothing to retire on either side, and a warning
        // from an earlier network would describe a path nobody wants now.
        this.failed(undefined);
        attempt.abort();
        return;
      }
      if (!signal.aborted) {
        const reason =
          error instanceof DirectConnectionError
            ? error.reason
            : error instanceof NoiseHandshakeError
              ? "noise_failed"
              : "switch_failed";
        this.failed(reason);
        if (!(error instanceof DirectConnectionError))
          emitDirectDiagnostic(this.options.onDiagnostic, {
            event: "failure",
            stage: error instanceof NoiseHandshakeError ? "noise" : "switch",
            reason,
          });
        // Scheduled before the fallback, whose own schedule() then keeps this shorter timer.
        if (
          error instanceof DirectConnectionError &&
          error.retrySoon &&
          this.quickRetries < QUICK_RETRY_LIMIT
        ) {
          this.quickRetries++;
          this.schedule(UPGRADE_RETRY_MS[0]);
        }
      }
      attempt.abort();
      await this.fallback();
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
      this.signals.reset();
      if (!this.direct) this.schedule();
    }
  }
  /**
   * Proves the pair the business Peer will actually run on. The data channel opens on the first
   * pair that works, and ICE may still move to another one while the remaining pairs are checked
   * (phone test 2026-11-15: the pair kind read at `direct_ready` alternated between punched and
   * unknown; probes passed, and seconds after the switch nothing crossed the path). So wait,
   * briefly, for the checks to finish, probe, and probe again when the pair changed meanwhile.
   */
  private async prove(direct: PathEndpoint, signal: AbortSignal) {
    let before = await this.settle(direct, signal);
    for (let round = 1; ; round++) {
      await this.verify(direct, signal, before);
      const after = await this.stats(direct);
      signal.throwIfAborted();
      direct.pair = after?.pair ?? before?.pair;
      if (round >= PROVE_ROUNDS || !before?.pair || !after?.pair || after.pair === before.pair)
        return;
      this.event({
        event: "direct_probe",
        result: "pair_changed",
        ...(direct.pathKind ? { kind: direct.pathKind } : {}),
      });
      before = after;
    }
  }
  /** Until no candidate pair is still being checked, at most SETTLE_MS; the last stats read. */
  private async settle(direct: PathEndpoint, signal: AbortSignal) {
    const end = Date.now() + SETTLE_MS;
    let stats = await this.stats(direct, 500);
    while (stats && stats.checking > 0 && Date.now() < end && !signal.aborted) {
      await pathDelay(signal, 250);
      stats = (await this.stats(direct, 500)) ?? stats;
    }
    signal.throwIfAborted();
    return stats;
  }
  /** The pre-switch round trips (path-probe.ts); a failure is logged with its code and rethrown. */
  private async verify(direct: PathEndpoint, signal: AbortSignal, stats?: PathStats) {
    const started = Date.now();
    const kind = direct.pathKind ? { kind: direct.pathKind } : {};
    const rtt = stats?.rttMs !== undefined ? { rttMs: stats.rttMs } : {};
    try {
      await this.probes.run(direct, signal);
      this.event({
        event: "direct_probe",
        result: "passed",
        ms: Date.now() - started,
        ...kind,
        ...rtt,
      });
    } catch (error) {
      if (error instanceof DirectConnectionError && !signal.aborted) {
        this.event({
          event: "direct_probe",
          result: error.reason,
          ms: Date.now() - started,
          ...kind,
        });
        emitDirectDiagnostic(this.options.onDiagnostic, {
          event: "failure",
          stage: "probe",
          reason: error.reason,
        });
      }
      throw error;
    }
  }
  /** waitFor for an idle relay; a timeout says what kept it busy before the switch fails. */
  private async waitIdle(signal: AbortSignal, predicate: () => boolean) {
    try {
      await waitFor(signal, predicate);
    } catch (error) {
      if (!signal.aborted && !this.relay.idle())
        emitDirectDiagnostic(this.options.onDiagnostic, {
          event: "relay_busy",
          ...this.relay.busy(),
        });
      throw error;
    }
  }
  private requireDirect(direct: PathEndpoint, signal: AbortSignal) {
    if (signal.aborted || this.direct !== direct || direct.wire.closed.aborted)
      throw new LinkError("path_closed");
  }
  private fallback(notify = true) {
    if (this.falling) return this.falling;
    const work = Promise.resolve().then(() => this.retireDirect(notify));
    this.falling = work;
    // Invalidate waits and queued activations before retiring or clearing their target.
    this.attempt?.abort();
    this.directAttempt?.abort();
    void work
      .finally(() => {
        if (this.falling === work) this.falling = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async retireDirect(notify: boolean) {
    const direct = this.direct;
    if (direct && this.selected === direct && !this.closed.aborted && !this.directFailure) {
      this.failed("channel_failed");
      emitDirectDiagnostic(this.options.onDiagnostic, {
        event: "failure",
        stage: "channel",
        reason: "channel_failed",
      });
    }
    // The other side gave this path up before switching: say which of its probes got here, so
    // both logs together show the direction that failed.
    if (direct && !direct.selected && this.options.role === "responder" && !this.closed.aborted)
      this.event({
        event: "direct_probe",
        result: `heard_${direct.probed ?? "none"}`,
        ...(direct.pathKind ? { kind: direct.pathKind } : {}),
      });
    // Given up by the other side (its link.path.fallback) or by this side without a loss event.
    if (direct && !this.closed.aborted) this.traffic(direct, notify ? "fallback" : "peer_fallback");
    this.direct = undefined;
    this.directAttempt = undefined;
    if (direct) this.retired.add(direct);
    this.preparing = false;
    this.relay.frozen = false;
    if (notify && !this.relay.wire.closed.aborted) {
      try {
        this.post("link.path.fallback", this.sequence);
      } catch {
        /* Relay owner reconnects. */
      }
    }
    try {
      if (this.selected === direct) {
        // A business bind still waiting on the dead path (up to its 10 s deadline) would hold the
        // relay activation queued behind it; its generation ends now.
        this.generation.abort();
        if (!this.closed.aborted && !this.relay.wire.closed.aborted)
          await this.activate(this.relay);
        else this.end(this.relayReason(this.relay));
      }
    } finally {
      if (direct) await this.retire(direct);
      if (!this.closed.aborted) this.schedule();
    }
  }
  private async retire(endpoint: PathEndpoint) {
    this.retired.add(endpoint);
    try {
      await endpoint.close();
      this.retired.delete(endpoint);
    } catch {
      this.end("drain_unconfirmed");
      throw new LinkError("drain_unconfirmed");
    }
  }
  private relayReason(relay: PathEndpoint) {
    return relay.lost ?? relay.wire.reason?.() ?? "relay_lost";
  }
  private async relayLoop() {
    while (!this.closed.aborted) {
      const relay = this.relay;
      await pathClosed(AbortSignal.any([this.closed, relay.wire.closed]));
      if (this.closed.aborted) break;
      // A negotiation is not a business path until both sides commit it.
      if (!this.direct || this.direct.wire.closed.aborted || this.selected !== this.direct) {
        this.end(this.relayReason(relay));
        break;
      }
      this.event({ event: "path_lost", path: "relay", reason: this.relayReason(relay) });
      await this.retire(relay);
      let delay = 1000;
      while (!this.closed.aborted && this.relay === relay) {
        this.relayAttempt = new AbortController();
        try {
          const wire = await this.options.reconnect(
            AbortSignal.any([this.closed, this.relayAttempt.signal]),
          );
          if (this.closed.aborted) {
            await wire.close();
            break;
          }
          this.relay = this.endpoint(wire, true);
          this.signals.reset();
          this.schedule(0);
        } catch {
          await pathDelay(AbortSignal.any([this.closed, this.relayAttempt.signal]), delay);
          delay = Math.min(60_000, delay * 2);
        }
      }
    }
  }
  /**
   * The other side is back after being away while this session stayed on the relay (a desktop
   * that quit and reopened): the grown backoff described the time it was gone, so the
   * next attempt starts now. A running attempt or a direct path in use is left alone.
   */
  retryDirectNow() {
    if (this.closed.aborted || this.direct || this.attempt) return;
    this.retries = 0;
    this.quickRetries = 0;
    this.schedule(0);
  }
  async networkChanged() {
    this.retries = 0;
    if (!this.relay.wire.closed.aborted) {
      try {
        this.post("link.path.fallback", this.sequence);
      } catch {
        /* The old network may already be gone. */
      }
    }
    // Retire immediately, without waiting for a metadata round trip on the old network.
    await this.close("network_change");
  }
  /** `reason` is announced to a keepalive-capable peer and becomes this side's end reason. */
  close(reason?: PathByeReason) {
    if (reason && !this.closed.aborted) {
      this.endCode ??= reason;
      if (this.keepalive !== undefined)
        for (const endpoint of this.live()) this.sendKeepalive(endpoint, { bye: reason });
    }
    this.closing ??= (async () => {
      this.stop();
      this.options.signal.removeEventListener("abort", this.stop);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      await this.changes;
      const endpoints = new Set([
        this.relay,
        ...this.retired,
        ...(this.direct ? [this.direct] : []),
      ]);
      const results = await Promise.allSettled([...endpoints].map((endpoint) => endpoint.close()));
      this.listeners.clear();
      this.failureListeners.clear();
      if (results.some((r) => r.status === "rejected")) throw new LinkError("drain_unconfirmed");
    })();
    return this.closing;
  }
}
