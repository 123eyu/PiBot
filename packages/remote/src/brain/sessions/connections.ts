import {
  type DirectFailure,
  type LinkPath,
  NoiseHandshakeError,
  type PathEvent,
} from "@pibot/link";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { EndpointRegistrySource } from "@pibot/protocol-base";
import {
  type DeviceView,
  isLegacyPhoneMethod,
  type PhoneDataState,
  phoneCapabilityForMethod,
  RemoteSessionUpdateSchema,
} from "@pibot/remote-contract";
import { transaction } from "@pibot/storage";
import { PhoneBrowser } from "../browser/phone-browser.ts";
import { pushScope, roomScope } from "../link/identity.ts";
import type { EndpointIdentity, LinkSession, RemoteLinkPort } from "../link/port.ts";
import type { RemoteOfflineService } from "../offline/service.ts";
import { isPhoneEvent } from "../rpc/allowlist.ts";
import { PhoneEventBuffer } from "../rpc/event-buffer.ts";
import { phoneGateway } from "../rpc/gateway.ts";
import type { RemoteKernelEvent, RemoteKernelPort } from "../rpc/port.ts";
import { settingsWriteFacts } from "../rpc/settings-allowlist.ts";
import { phoneSettingsGuard } from "../rpc/settings-gate.ts";
import type { RemoteResources } from "../runtime/context.ts";
import { RunnerConnections } from "./runners.ts";

interface Entry {
  controller: AbortController;
  settled: Promise<void>;
  online: boolean;
  foreground: boolean;
  failed: boolean;
  path: "direct" | "relay";
  /** Candidate statistics belong to this connection attempt, never the paired device record. */
  pathKind?: "lan" | "punched" | "relay";
  directFailure?: DirectFailure;
  session?: LinkSession;
  gateway?: ReturnType<typeof phoneGateway>;
  drainingGateway?: ReturnType<typeof phoneGateway>;
  browser?: PhoneBrowser;
  /** What the phone reported in this session; display and phone choice only. */
  phoneData?: PhoneDataState;
  wakeReady?: boolean;
  pushUpdate?: Promise<void>;
  connectingSince?: number;
  connectAttempt?: AbortController;
  connectPhase?: "socket_open" | "waiting_presence" | "handshake" | "closed";
  /** Set by close(): this side is draining, not the phone or the network. */
  draining?: boolean;

  retireEndpoint?: () => void;
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
function readPushSettings(saved: string) {
  try {
    const { token, language, wake } = JSON.parse(saved);
    const result = RemoteSessionUpdateSchema.safeParse({
      foreground: false,
      pushToken: token,
      language,
      wake,
    });
    return result.success ? result.data : undefined;
  } catch {
    // An unreadable old record can be replaced by a fresh registration.
    return undefined;
  }
}
const FIXED_CODE = /^[a-z][a-z0-9_]{2,60}$/;
export class RemoteConnections {
  readonly runners: RunnerConnections;
  private entries = new Map<string, Entry>();
  private buffers = new Map<string, PhoneEventBuffer>();
  private watchdog?: ReturnType<typeof setInterval>;
  constructor(
    private readonly r: RemoteResources,
    private readonly changed: () => void,
    private readonly offline?: RemoteOfflineService,
    private readonly interactive: () => "available" | "quit" = () => "available",
  ) {
    this.runners = new RunnerConnections(r, changed);
  }
  /** Phone session lifecycle, like the runner-link log: fixed codes and durations only. */
  private log(level: "info" | "warn", event: string, fields: Record<string, string | number> = {}) {
    const safe: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(fields))
      if (
        typeof value === "number"
          ? Number.isFinite(value)
          : typeof value === "string" && FIXED_CODE.test(value)
      )
        safe[key] = value;
    this.r.ctx.logger[level](JSON.stringify({ module: "phone-link", event, ...safe }));
  }
  // Every PathEvent field is a fixed code or a number; log() still drops anything else.
  private pathEvent = ({ event, ...fields }: PathEvent) =>
    this.log(
      event === "path_lost" ||
        event === "direct_traffic" ||
        (event === "direct_probe" && "result" in fields && fields.result !== "passed")
        ? "warn"
        : "info",
      event,
      fields as Record<string, string | number>,
    );
  /**
   * An event for one phone only (its offline grants changed). Buffered while it is away, so
   * a phone that reconnects within the replay window still learns; beyond it the manifest
   * comparison on connect does the same.
   */
  emitTo(id: string, method: string, payload: unknown) {
    if (!isPhoneEvent(method)) return;
    const entry = this.entries.get(id);
    if (entry?.gateway) entry.gateway.emit(method, payload, entry.online && entry.foreground);
    else this.buffers.get(id)?.append(method, payload);
  }
  online(id: string) {
    return this.entries.get(id)?.online ?? this.runners.online(id);
  }
  path(id: string): DeviceView["path"] {
    const entry = this.entries.get(id);
    if (entry) return entry.path === "direct" ? (entry.pathKind ?? "direct") : "relay";
    return this.runners.path(id) === "relay" ? "relay" : "direct";
  }
  directFailure(id: string) {
    const entry = this.entries.get(id);
    return entry?.online && entry.path === "relay" ? entry.directFailure : undefined;
  }
  foreground(id: string) {
    const e = this.entries.get(id);
    return !!e?.online && e.foreground;
  }
  phoneData(id: string) {
    const e = this.entries.get(id);
    return e?.online ? e.phoneData : undefined;
  }
  /** Phones a Bot can reach now (online, with a session), in pairing order. */
  phones() {
    return [...this.entries].flatMap(([deviceId, e]) =>
      e.online && e.gateway
        ? [
            {
              deviceId,
              state: e.phoneData ?? null,
              gateway: e.gateway,
              wakeReady: e.wakeReady === true,
            },
          ]
        : [],
    );
  }
  onlineCount() {
    return [...this.entries.values()].filter((e) => e.online).length + this.runners.count();
  }
  busy() {
    return (
      this.runners.busy() ||
      [...this.entries.values()].some((e) => e.online || (e.failed && e.session))
    );
  }
  state() {
    const values = [...this.entries.values()];
    return values.some((e) => e.failed)
      ? ("connection_failed" as const)
      : values.some((e) => !e.session)
        ? ("connecting" as const)
        : ("ready" as const);
  }
  start(
    link: RemoteLinkPort,
    kernel: RemoteKernelPort,
    identity: EndpointIdentity,
    relayUrl: string,
    signal: AbortSignal,
  ) {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const entry of this.entries.values()) {
        if (
          !entry.online &&
          entry.connectingSince &&
          (entry.connectPhase === undefined || entry.connectPhase === "closed") &&
          now - entry.connectingSince > 120_000
        ) {
          this.r.ctx.logger.warn("remote.session_watchdog_timeout");
          entry.connectAttempt?.abort(new Error("remote_connect_watchdog_timeout"));
        }
      }
    }, 10_000);
    this.watchdog.unref?.();
    this.runners.start(link, identity, relayUrl, signal);
    for (const record of this.r.devices.page({ limit: 100 }).items) {
      if (record.kind === "runner") continue;
      if (this.entries.has(record.id)) continue;
      const entry: Entry = {
        controller: new AbortController(),
        settled: Promise.resolve(),
        online: false,
        foreground: true,
        failed: false,
        path: "relay",
      };
      this.entries.set(record.id, entry);
      this.buffers.set(record.id, this.buffers.get(record.id) ?? new PhoneEventBuffer());
      entry.settled = this.connect(
        record.id,
        entry,
        link,
        kernel,
        identity,
        relayUrl,
        AbortSignal.any([signal, entry.controller.signal]),
      );
      void entry.settled.catch(() => this.r.ctx.logger.warn("Remote session cleanup unavailable"));
    }
  }
  private async connect(
    id: string,
    entry: Entry,
    link: RemoteLinkPort,
    kernel: RemoteKernelPort,
    identity: EndpointIdentity,
    relayUrl: string,
    signal: AbortSignal,
  ) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const record = this.r.devices.active(id);
        const roomSecret = await this.r.secrets.get(roomScope(id), "room");
        signal.throwIfAborted();
        if (!roomSecret || !record.publicKey || !record.room)
          throw new Error("remote_room_unavailable");
        entry.connectingSince = Date.now();
        const connectAttempt = new AbortController();
        entry.connectAttempt = connectAttempt;
        const connectSignal = AbortSignal.any([signal, connectAttempt.signal]);
        entry.connectPhase = undefined;
        entry.pathKind = undefined;
        const session: LinkSession = await link.connect({
          identity,
          publicKey: record.publicKey,
          room: record.room,
          roomSecret,
          relayUrl,
          ...(this.r.settings.get().direct.mode === "stun"
            ? { stunUrl: this.r.settings.get().direct.stunUrl }
            : {}),
          signal: connectSignal,
          onPhase: (phase) => {
            entry.connectPhase = phase;
            this.r.ctx.logger.info(`remote.session_${phase}`);
          },
          onEvent: (event) => {
            if (connectSignal.aborted || entry.connectAttempt !== connectAttempt) return;
            this.pathEvent(event);
            if (event.event === "path_selected") {
              entry.pathKind = event.kind === "unknown" ? undefined : event.kind;
            }
          },
        });
        const connectMs = Date.now() - (entry.connectingSince ?? Date.now());
        entry.connectingSince = undefined;
        entry.session = session;
        this.r.ctx.logger.info("remote.session_connected");
        this.r.devices.active(id);
        signal.throwIfAborted();
        const parentSignal = signal;
        const bind = async (path: LinkPath) => {
          entry.retireEndpoint?.();
          // publish must buffer during drain instead of emitting through a disposed Peer.
          entry.drainingGateway = entry.gateway ?? entry.drainingGateway;
          entry.gateway = undefined;
          await entry.drainingGateway?.close();
          entry.drainingGateway = undefined;
          const signal = AbortSignal.any([parentSignal, path.closed]);
          signal.throwIfAborted();
          const registry = this.r.ctx.ports.get<EndpointRegistrySource>("endpoints.registry");
          let revision = 0;
          let retired = false;
          let admission = new AbortController();
          entry.wakeReady = false;
          let accepted = 0;
          let modern = !!registry;
          let enabled: readonly string[] = [];
          let unsubscribe: (() => void) | undefined;
          const sendEnabled = (ids: readonly string[]) => {
            if (signal.aborted || retired) return;
            // Scope-only changes also revoke in-flight reads, even when IDs are unchanged.
            admission.abort(new RpcError(RpcErrorCodes.unsupported, "capability_off"));
            admission = new AbortController();
            enabled = [...ids];
            accepted = 0;
            entry.wakeReady = false;
            revision++;
            path.port.post({
              jsonrpc: "2.0",
              method: "endpoint.enabled",
              params: { capabilities: enabled, revision },
            });
          };
          signal.addEventListener(
            "abort",
            () => {
              unsubscribe?.();
              unsubscribe = undefined;
            },
            { once: true },
          );
          entry.retireEndpoint = () => {
            retired = true;
            admission.abort(new RpcError(RpcErrorCodes.unsupported, "phone_offline"));
            accepted = 0;
            unsubscribe?.();
            unsubscribe = undefined;
          };
          entry.path = path.path;
          entry.browser = new PhoneBrowser({
            deviceId: id,
            ports: this.r.ctx.ports,
            audit: (method, outcome) => this.r.audit(id, method, outcome),
            warn: (message) => this.r.ctx.logger.warn(message),
          });
          // One stream per paired phone across its reconnects and path changes (the phone resumes
          // from its cursor); only a brain restart, remote off or unpair starts a new one.
          const buffer = this.buffers.get(id) ?? new PhoneEventBuffer();
          this.buffers.set(id, buffer);
          entry.gateway = phoneGateway({
            deviceId: id,
            port: path.port,
            kernel,
            buffer,
            receipts: this.r.receipts,
            signal,
            active: () => {
              signal.throwIfAborted();
              this.r.devices.active(id);
            },
            authorize: (method, input) => {
              if (method !== "approvals.resolve") return;
              const approval = this.r.ctx.local.approvals.repo.get((input as { id: string }).id);
              if (approval?.computer || approval?.login || approval?.draft)
                throw new RpcError(RpcErrorCodes.unsupported, "remote_approval_requires_desktop");
            },
            self: () => ({
              ...(registry ? { endpointCapabilities: 1 as const } : {}),
              desktopId: this.r.settings.desktopId(),
              desktopName: this.r.ctx.redactor.redact(this.r.settings.get().desktopName),
              deviceId: id,
              deviceName: this.r.devices.active(id).name,
              direct: this.r.settings.get().direct,
              lanAddresses: link.lanAddresses?.(roomSecret) ?? [],
              ...(session.keepalive ? { linkKeepalive: 1 as const } : {}),
              eventStream: { id: buffer.id, seq: buffer.seq },
              interactive: this.interactive(),
            }),
            update: (params) => this.update(id, entry, params, signal),
            ...(this.offline
              ? {
                  offline: (
                    method: Parameters<RemoteOfflineService["handle"]>[1],
                    input: unknown,
                    requestSignal: AbortSignal,
                  ) =>
                    (this.offline as RemoteOfflineService).handle(id, method, input, requestSignal),
                }
              : {}),
            browser: entry.browser,
            phoneCapabilitySignal: () => admission.signal,
            phoneCapabilityAllowed: (method) =>
              !retired &&
              (modern
                ? accepted === revision && enabled.includes(phoneCapabilityForMethod(method))
                : isLegacyPhoneMethod(method)),
            phoneData: (state) => {
              signal.throwIfAborted();
              if (!state.manifest && state.acceptedRevision === undefined && revision === 0)
                modern = false;
              if (state.manifest) {
                modern = true;
                accepted = 0;
                if (
                  !registry ||
                  state.manifest.endpointKind !== "phone" ||
                  state.manifest.platform !== state.platform
                )
                  throw new RpcError(RpcErrorCodes.invalidParams, "phone_manifest_invalid");
                registry.receive(id, state.manifest);
                unsubscribe?.();
                unsubscribe = registry.subscribe(id, sendEnabled);
                sendEnabled(registry.enabled(id));
              }
              if (state.acceptedRevision === revision && modern) {
                accepted = revision;
                entry.wakeReady = true;
              }
              if (state.acceptedRevision === undefined) entry.wakeReady = true;
              if (state.acceptedRevision === undefined)
                entry.phoneData = {
                  platform: state.platform,
                  media: state.media,
                  smsCode: state.smsCode,
                };
              this.r.changed();
              return {
                ok: true as const,
                ...(modern ? { enabled: { capabilities: [...enabled], revision } } : {}),
              };
            },
            guard: phoneSettingsGuard({
              kernel,
              deviceId: id,
              signal,
              audit: (method, outcome, facts) => this.r.audit(id, method, outcome, "phone", facts),
            }),
            audit: (method, outcome, params) =>
              this.r.audit(id, method, outcome, "phone", settingsWriteFacts(method, params)),
          });
          this.r.changed();
        };
        await bind(
          session.currentPath?.() ?? {
            port: session.port,
            path: "relay",
            closed: session.signal ?? signal,
          },
        );
        const offPath = session.onPath?.(bind);
        const offFailure = session.onDirectFailure?.((reason) => {
          if (signal.aborted) return;
          entry.directFailure = reason;
          this.r.changed();
        });
        const off = session.onPresence((online) => {
          if (signal.aborted) return;
          this.r.devices.active(id);
          entry.online = online;
          // A phone that left cannot see the page; the Bot gets its browser back.
          if (!online)
            void entry.browser
              ?.release("offline")
              .catch(() => this.r.ctx.logger.warn("Remote browser hand-back unavailable"));
          if (online) this.r.devices.seen(id);
          this.r.changed();
          this.changed();
        });
        entry.failed = false;
        backoff = 1000;
        this.changed();
        const openedAt = Date.now();
        this.log("info", "connected", { path: entry.path, connectMs });
        try {
          this.r.ctx.logger.info("remote.session_waiting");
          await delay(
            2_147_483_647,
            session.signal ? AbortSignal.any([signal, session.signal]) : signal,
          );
        } finally {
          off();
          offPath?.();
          offFailure?.();
          const transport = session.endReason?.();
          const reason = entry.draining
            ? "desktop_drain"
            : signal.aborted
              ? "desktop_stop"
              : (transport ?? "closed");
          this.log(reason.startsWith("desktop_") ? "info" : "warn", "closed", {
            reason,
            ...(transport && transport !== reason ? { transport } : {}),
            path: entry.path,
            onlineMs: Date.now() - openedAt,
          });
        }
      } catch (error) {
        // Maintainers 2026-11-12 "手机连接还是有点慢": the relay retires an idle socket while the desktop
        // only waits for the phone (seen after ~17 min). That is not a failure; doubling the
        // backoff to 60 s kept the desktop out of the room when the app was opened (24 s measured).
        // Rejoin at once so an opened phone finds the desktop waiting.
        // A relay that drops sockets right away still backs off (no 1 s loop).
        const idleWait =
          entry.connectPhase === "waiting_presence" &&
          Date.now() - (entry.connectingSince ?? Date.now()) >= 30_000;
        if (idleWait) backoff = 1000;
        if (!signal.aborted && !idleWait) {
          entry.failed = true;
          // Own error codes only (snake_case); anything else may carry addresses or keys.
          const message = error instanceof Error ? error.message : "";
          const reason = /^[a-z][a-z0-9_]{2,60}$/.test(message) ? message : "unexpected";
          this.r.ctx.logger.warn(`Remote connection unavailable: ${reason}`);
          this.r.ctx.logger.info("remote.session_error");
          if (error instanceof NoiseHandshakeError)
            this.r.ctx.logger.warn(
              JSON.stringify({
                module: "remote-link",
                event: "handshake_failed",
                phase: error.phase,
              }),
            );
        }
      }
      entry.connectingSince = undefined;
      entry.connectAttempt = undefined;
      entry.connectPhase = undefined;

      entry.retireEndpoint?.();
      entry.retireEndpoint = undefined;
      entry.online = false;
      if (!signal.aborted) this.r.ctx.logger.info("remote.session_disconnected");
      const closed = await Promise.allSettled([
        entry.gateway?.close(),
        entry.drainingGateway?.close(),
        entry.session?.close(),
      ]);
      if (closed.some((result) => result.status === "rejected")) {
        entry.failed = true;
        this.changed();
        throw new Error("remote_session_drain_failed");
      }
      entry.gateway = undefined;
      entry.drainingGateway = undefined;
      entry.browser = undefined;
      entry.session = undefined;
      entry.phoneData = undefined;
      entry.pathKind = undefined;
      entry.directFailure = undefined;
      this.changed();
      if (!signal.aborted) {
        await delay(backoff, signal);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  private async update(id: string, entry: Entry, params: unknown, signal: AbortSignal) {
    const input = RemoteSessionUpdateSchema.parse(params);
    signal.throwIfAborted();
    this.r.devices.active(id);
    entry.foreground = input.foreground;
    const pending = (entry.pushUpdate ?? Promise.resolve()).then(() =>
      this.updatePush(id, input.pushToken, input.language, input.wake, signal),
    );
    // Keep token mutations in arrival order, including after a failed write.
    entry.pushUpdate = pending.catch(() => undefined);
    if (input.foreground && entry.online) entry.gateway?.catchUp();
    // A phone in the background cannot see the page; the Bot gets its browser back.
    await Promise.all([pending, !input.foreground && entry.browser?.release("background")]);
    return { ok: true as const };
  }
  private async updatePush(
    id: string,
    token: string | null | undefined,
    language: "zh" | "en",
    wake: boolean | undefined,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const scope = pushScope(id);
    const device = this.r.devices.active(id);
    const saved = device.pushToken ? await this.r.secrets.get(scope, "token") : undefined;
    const current = saved ? readPushSettings(saved) : undefined;
    const nextToken = token === undefined ? current?.pushToken : token;
    // Older phones omit wake. Preserve the saved preference instead of silently disabling it.
    const nextWake = wake ?? current?.wake === true;
    if (
      token === undefined &&
      (!nextToken || (current?.language === language && (current.wake === true) === nextWake))
    )
      return;
    if (token === null && !device.pushToken) return;
    if (nextToken) this.r.ctx.redactor.add(nextToken);
    if (
      token &&
      current?.pushToken === token &&
      current.language === language &&
      (current.wake === true) === nextWake
    )
      return;
    const next = nextToken
      ? JSON.stringify({ token: nextToken, language, wake: nextWake })
      : undefined;
    if (next && saved === next) return;
    const commit = next ? await this.r.secrets.prepareSet(scope, "token", next) : undefined;
    signal.throwIfAborted();
    this.r.devices.active(id);
    transaction(this.r.ctx.db, () => {
      commit?.();
      if (token === null || !next) this.r.secrets.remove(scope, "token");
      this.r.devices.pushReference(id, next ? scope : null);
    });
    this.r.audit(id, "remote.session.update", "changed", "phone");
  }
  publish(event: RemoteKernelEvent) {
    if (!isPhoneEvent(event.method)) return;
    for (const [id, buffer] of this.buffers) {
      try {
        const entry = this.entries.get(id);
        if (!this.r.devices.get(id)?.publicKey) continue;
        if (entry?.gateway)
          entry.gateway.emit(event.method, event.payload, entry.online && entry.foreground);
        else if (
          event.method !== "chat.delta" &&
          event.method !== "chat.tool" &&
          event.method !== "chat.activity"
        )
          buffer.append(event.method, event.payload);
      } catch {
        // A failed device cannot prevent the other devices from receiving the same event.
        this.r.ctx.logger.warn("Remote device event delivery unavailable");
      }
    }
  }
  async close(id?: string, options: { runners?: boolean } = {}) {
    if (options.runners !== false) await this.runners.close(id);
    const entries = [...this.entries].filter(([key]) => !id || key === id);
    for (const [, entry] of entries) {
      // Tell a keepalive-capable phone this is a drain, so it logs the cause and retries at once.
      entry.draining = true;
      void entry.session?.close("drain").catch(() => {
        /* The connect loop's own close below owns the drain result. */
      });
      entry.controller.abort();
    }
    const settled = await Promise.allSettled(entries.map(([, entry]) => entry.settled));
    for (let index = 0; index < settled.length; index++) {
      if (settled[index]?.status !== "rejected") continue;
      const entry = entries[index]?.[1];
      const retried = await Promise.allSettled([
        entry?.gateway?.close(),
        entry?.drainingGateway?.close(),
        entry?.session?.close(),
      ]);
      if (retried.some((result) => result.status === "rejected"))
        throw new Error("remote_connection_drain_failed");
    }
    for (const [key] of entries) this.entries.delete(key);
    if (!id) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    if (id) this.buffers.delete(id);
    this.r.changed();
  }
  clearBuffers() {
    this.buffers.clear();
  }
}
