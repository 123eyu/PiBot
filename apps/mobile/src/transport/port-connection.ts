import type { PathByeReason } from "@pibot/link";
import {
  isLegacyPhoneMethod,
  type MethodParams,
  type MethodResults,
  Methods,
  type Port,
  phoneCapabilityForMethod,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { splitDesktopCalls } from "./desktop-calls.ts";
import type { LinkConnection } from "./link-port.ts";
import { remotePeer } from "./remote-peer.ts";

/**
 * The phone's view of one authenticated session port: its metadata calls (identity, outbox,
 * push, share upload, data switches) and the computer's calls to the phone. The real link
 * builds it over the encrypted port; the dev probes over an in-memory one, so both run this code.
 */
export function portConnection(input: {
  port: Port;
  /** Aborts when the session ends (socket closed or retired). */
  closed: AbortSignal;
  close(reason?: PathByeReason): Promise<void>;
  epoch?: string;
  path?: "direct" | "relay";
  pathKind?: string;
  onDirectSettings?(settings: MethodResults["devices.self"]["direct"]): void;
  /** The computer understands the end-to-end keepalive (`devices.self.linkKeepalive`). */
  onKeepalive?(): void;
  onInteractive?(state: "available" | "quit"): void;
}): LinkConnection {
  let modern = false;
  // Set once on unpair: no phone read on this connection may be admitted again, whatever
  // manifest or endpoint.enabled answer arrives late. Only a new pairing session reopens.
  let revoked = false;
  let enabled = new Set<string>();
  let revision = 0;
  let state: MethodParams["remote.phoneData.state"] | undefined;
  let lastPushSettings: string | undefined;
  const split = splitDesktopCalls(
    input.port,
    input.closed,
    // Before (or without) negotiation only the pre-manifest methods keep their legacy path.
    (method) =>
      !revoked &&
      (modern ? enabled.has(phoneCapabilityForMethod(method)) : isLegacyPhoneMethod(method)),
  );
  const metadata = remotePeer(split.port);
  const interactiveListeners = new Set<(state: "available" | "quit") => void>();
  const notifyInteractive = (state: "available" | "quit") => {
    input.onInteractive?.(state);
    for (const listener of interactiveListeners) listener(state);
  };
  const offInteractive = metadata.on("remote.interactive", (event) =>
    notifyInteractive(event.interactive),
  );
  const signal = (request: AbortSignal) => AbortSignal.any([request, input.closed]);
  const accept = async (value: unknown) => {
    if (revoked || !modern || input.closed.aborted || !state) return;
    const parsed = Methods["remote.phoneData.state"].result.safeParse({ ok: true, enabled: value });
    const update = parsed.success ? parsed.data.enabled : undefined;
    if (!update || update.revision <= revision) return;
    split.invalidate();
    revision = update.revision;
    const appliedRevision = revision;
    enabled = new Set(
      update.capabilities.filter((id) =>
        ["phone.media", "phone.sms", "phone.calls", "phone.notifications"].includes(id),
      ),
    );
    try {
      await metadata.call(
        "remote.phoneData.state",
        {
          platform: state.platform,
          media: state.media,
          smsCode: state.smsCode,
          acceptedRevision: revision,
        },
        { signal: input.closed, timeoutMs: 10000 },
      );
    } catch {
      // No acknowledgement means the desktop must keep admission closed.
      if (revision === appliedRevision) enabled.clear();
    }
  };
  const offEnabled = input.port.onMessage((raw) => {
    const message = raw as {
      jsonrpc?: unknown;
      method?: unknown;
      params?: unknown;
      id?: unknown;
    } | null;
    if (
      message?.jsonrpc === "2.0" &&
      message.method === "endpoint.enabled" &&
      message.id === undefined
    )
      void accept(message.params);
  });
  const retire = () => {
    enabled.clear();
    offEnabled();
    metadata.dispose();
    offInteractive();
    interactiveListeners.clear();
  };
  input.closed.addEventListener("abort", retire, { once: true });
  return {
    supportsEndpointCapabilities: () => modern,
    port: split.port,
    path: input.path ?? "relay",
    ...(input.path === "direct" && (input.pathKind === "lan" || input.pathKind === "punched")
      ? { pathKind: input.pathKind }
      : {}),
    closed: input.closed,
    ...(input.epoch ? { epoch: input.epoch } : {}),
    onClose(listener) {
      const abort = () => listener();
      input.closed.addEventListener("abort", abort, { once: true });
      if (input.closed.aborted) abort();
      return () => input.closed.removeEventListener("abort", abort);
    },
    async close(reason) {
      retire();
      await input.close(reason);
    },
    async self(requestSignal) {
      const value = await metadata.call("devices.self", undefined, {
        signal: signal(requestSignal),
        timeoutMs: 10_000,
      });
      modern = value.endpointCapabilities === 1;
      input.onDirectSettings?.(value.direct);
      if (value.linkKeepalive === 1) input.onKeepalive?.();
      notifyInteractive(value.interactive ?? "available");
      return {
        id: value.desktopId,
        name: value.desktopName,
        lanAddresses: value.lanAddresses,
        ...(value.eventStream ? { eventStream: value.eventStream } : {}),
      };
    },
    send(message, requestSignal, attachmentIds) {
      return metadata.call(
        "chat.send",
        {
          ...message.target,
          text: message.text,
          ...(message.mentions?.length ? { mentions: message.mentions } : {}),
          ...(attachmentIds?.length ? { attachmentIds } : {}),
          clientMessageId: message.clientId,
        },
        { signal: signal(requestSignal), timeoutMs: 30_000 },
      );
    },
    async setPushToken(token, language, requestSignal, wake) {
      const key = JSON.stringify([token, language, wake === true]);
      if (key === lastPushSettings) return;
      try {
        await metadata.call(
          "remote.session.update",
          { foreground: true, pushToken: token, language, wake },
          { signal: signal(requestSignal), timeoutMs: 20_000 },
        );
        lastPushSettings = key;
      } catch (error) {
        // Token registration is idempotent. Only a strict old contract rejection gets a retry;
        // timeouts and transport failures never replay an accepted write.
        if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.invalidParams) throw error;
        await metadata.call(
          "remote.session.update",
          { foreground: true, pushToken: token, language },
          { signal: signal(requestSignal), timeoutMs: 20_000 },
        );
        lastPushSettings = JSON.stringify([token, language, false]);
      }
    },
    async reportForeground(foreground, language, requestSignal) {
      await metadata.call(
        "remote.session.update",
        { foreground, language },
        { signal: signal(requestSignal), timeoutMs: 10_000 },
      );
    },
    uploadChunk(params, requestSignal) {
      return metadata.call("remote.share.upload", params, {
        signal: signal(requestSignal),
        timeoutMs: 30_000,
      });
    },
    invalidatePhoneReads() {
      split.invalidate();
      enabled.clear();
    },
    revokePhoneReads() {
      revoked = true;
      split.invalidate();
      enabled.clear();
    },
    async reportPhoneData(nextState, requestSignal) {
      // A newer local state invalidates the prior enabled snapshot until it is confirmed again.
      if (revoked) return;
      split.invalidate();
      enabled.clear();
      state = nextState;
      const result = await metadata.call("remote.phoneData.state", nextState, {
        signal: signal(requestSignal),
        timeoutMs: 10_000,
      });
      if (result.enabled) await accept(result.enabled);
    },
    onInteractive(listener) {
      interactiveListeners.add(listener);
      return () => interactiveListeners.delete(listener);
    },
    serve: (handler) => split.serve(handler),
  };
}
