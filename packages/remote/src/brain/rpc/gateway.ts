import { createHash } from "node:crypto";
import {
  createPeer,
  type EventBuffer,
  Events,
  IdSchema,
  type MethodParams,
  Methods,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { z } from "zod";
import type { RemoteReceiptsRepo } from "../../store/index.ts";
import { isPhoneBrowserMethod, type PhoneBrowser } from "../browser/phone-browser.ts";
import { isOfflinePhoneMethod, type OfflinePhoneMethod } from "../offline/service.ts";
import {
  isPhoneEvent,
  isPhoneMethod,
  isPhoneRead,
  phoneMethods,
  restrictPhoneParams,
} from "./allowlist.ts";
import { phoneCaller } from "./phone-caller.ts";
import type { RemoteKernelPort } from "./port.ts";
import { previewChunks } from "./preview-chunks.ts";
import { clampRecordParams, clampRecordResult, isRecordMethod } from "./records-limits.ts";
import { PHONE_UNLOCK_KEY } from "./settings-allowlist.ts";
import { shareUploads } from "./share-uploads.ts";

const MAX_BYTES = 900_000;
// Longer than a send that converts several attachments; the receipt settles either way.
const SEND_SETTLE_MS = 120_000;
/**
 * Polled several times a second while the phone watches the Bot browser; one audit row each
 * would bury everything else. Viewing and takeovers are audited by PhoneBrowser and the browser
 * capability instead (start / end, duration, site); refusals are still audited here.
 */
const unaudited = new Set([
  "remote.browser.frame",
  "remote.browser.input",
  // One row per slice would bury the log; a finished upload is audited once, and the chat.send
  // that uses it as usual.
  "remote.share.upload",
]);
// Session presence is state synchronization; its audit is emitted only when settings change.
const quiet = (method: string) =>
  method === "remote.session.update" || unaudited.has(method) || isPhoneRead(method);
interface GatewayOptions {
  deviceId: string;
  port: Port;
  kernel: RemoteKernelPort;
  buffer: EventBuffer<typeof Events>;
  receipts: RemoteReceiptsRepo;
  signal: AbortSignal;
  active(): void;
  self(): unknown;
  update(params: unknown): Promise<unknown>;
  browser: PhoneBrowser;
  /** The phone reported which data switches it has on (display only; it enforces them). */
  phoneData?(state: MethodParams["remote.phoneData.state"]): unknown;
  phoneCapabilityAllowed?(method: string): boolean;
  /** This phone's offline manifest, snapshots and upload (the remote capability answers). */
  offline?(method: OfflinePhoneMethod, params: unknown, signal: AbortSignal): Promise<unknown>;
  phoneCapabilitySignal?(): AbortSignal;
  authorize?(method: string, params: unknown): void;
  /** Settings checks against current state (unlock mark, narrowing); returns what to dispatch. */
  guard?(method: keyof typeof Methods, params: unknown, signal: AbortSignal): Promise<unknown>;
  /** `params` (raw on refusal) only feed field-name facts; values are never recorded. */
  audit(
    method: string,
    outcome: "started" | "allowed" | "refused" | "failed",
    params?: unknown,
  ): void;
}
const messageKey = (id: unknown) => JSON.stringify([typeof id, id]);
export function phoneGateway(options: GatewayOptions) {
  const pending = new Map<string, string>();
  const tasks = new Set<Promise<unknown>>();
  const previews = previewChunks((method, params, signal) =>
    options.kernel.dispatch(method, params, { deviceId: options.deviceId, signal }),
  );
  // Desktop → phone calls share this port; their answers are consumed before the peer.
  const caller = phoneCaller(options.port);
  const uploads = shareUploads();
  const methods = {
    ...Methods,
    "chat.send": {
      ...Methods["chat.send"],
      params: Methods["chat.send"].params.safeExtend({ clientMessageId: IdSchema }),
    },
    // The phone's local-unlock mark; settings-gate.ts consumes and strips it.
    "permissions.set": {
      ...Methods["permissions.set"],
      params: Methods["permissions.set"].params.safeExtend({
        [PHONE_UNLOCK_KEY]: z.literal(true).optional(),
      }),
    },
  };
  const sendError = (id: unknown, code: number, message: string) =>
    options.port.post({ jsonrpc: "2.0", id, error: { code, message } });
  // The last sequence this phone has been sent on this session (live or by its events.resume);
  // undefined until it resumed. Events buffered while it was in the background go out before the
  // next live one, so its cursor never skips them (a reconnect resumes from that cursor).
  let delivered: number | undefined;
  let behind = false;
  const resumeAfter = new Map<string, number>();
  const sent = (seq: unknown) => {
    if (typeof seq === "number" && Number.isSafeInteger(seq))
      delivered = Math.max(delivered ?? 0, seq);
  };
  const catchUp = () => {
    if (!behind || delivered === undefined || options.signal.aborted) return;
    behind = false;
    try {
      for (const event of options.buffer.resume(delivered)) {
        options.port.post(event);
        sent(event.params.seq);
      }
    } catch {
      // Evicted meanwhile: the phone's next events.resume gets resumeUnavailable and reloads.
    }
  };
  const peer = createPeer(
    {
      post(raw) {
        const message = raw as Record<string, unknown>;
        const key = messageKey(message.id);
        const method = pending.get(key);
        if (method) {
          pending.delete(key);
          if (method === "events.resume" && "error" in message) options.audit(method, "failed");
          if (method === "events.resume" && Array.isArray(message.result)) {
            sent(resumeAfter.get(key));
            for (const event of message.result as { params?: { seq?: unknown } }[])
              sent(event?.params?.seq);
          }
          resumeAfter.delete(key);
        } else if (typeof message.method === "string" && message.id === undefined) {
          sent((message.params as { seq?: unknown } | undefined)?.seq);
        }
        // Large replay/history falls back to a fresh paginated read rather than an unbounded frame.
        if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES)
          return sendError(
            message.id,
            RpcErrorCodes.resumeUnavailable,
            "remote_response_too_large",
          );
        options.port.post(raw);
      },
      onMessage(listener) {
        return options.port.onMessage((raw) => {
          if (caller.receive(raw)) return;
          const request = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          const method =
            typeof request.method === "string" && isPhoneMethod(request.method)
              ? request.method
              : "unavailable_method";
          try {
            options.active();
            if (Buffer.byteLength(JSON.stringify(raw) ?? "") > MAX_BYTES)
              throw new RpcError(RpcErrorCodes.invalidRequest, "remote_request_too_large");
            if (
              typeof request.id !== "string" ||
              request.id.length > 128 ||
              request.jsonrpc !== "2.0"
            )
              throw new RpcError(RpcErrorCodes.invalidRequest, "remote_request_invalid");
            if (method === "unavailable_method")
              throw new RpcError(RpcErrorCodes.methodNotFound, "remote_method_unavailable");
            const key = messageKey(request.id);
            if (pending.size >= 16 || pending.has(key))
              throw new RpcError(RpcErrorCodes.busy, "remote_request_capacity");
            restrictPhoneParams(method, request.params);
            if (!quiet(method)) options.audit(method, "started");
            pending.set(key, method);
            if (method === "events.resume") {
              const after = (request.params as { afterSeq?: unknown } | undefined)?.afterSeq;
              if (typeof after === "number") resumeAfter.set(key, after);
            }
            listener(raw);
          } catch (error) {
            options.audit(method, "refused", request.params);
            sendError(
              typeof request.id === "string" ? request.id.slice(0, 128) : null,
              error instanceof RpcError ? error.code : RpcErrorCodes.invalidRequest,
              error instanceof RpcError ? error.message : "remote_request_invalid",
            );
          }
        });
      },
      cancelRequest: (id) => options.port.cancelRequest?.(id),
      onRequestCancel: (listener) => options.port.onRequestCancel?.(listener) ?? (() => {}),
    },
    {
      methods,
      events: Events,
      eventBuffer: options.buffer,
      onError({ method, stage }) {
        if (stage === "params" || stage === "result") options.audit(method, "failed");
      },
    },
  );

  async function execute(method: keyof typeof Methods, input: unknown, requestSignal: AbortSignal) {
    requestSignal.throwIfAborted();
    options.active();
    options.authorize?.(method, input);
    if (method === "devices.self") return options.self();
    if (method === "remote.session.update") return options.update(input);
    if (method === "remote.preview.read")
      return previews.read(input as MethodParams["remote.preview.read"], requestSignal);
    if (isPhoneBrowserMethod(method)) return options.browser.handle(method, input, requestSignal);
    if (method === "remote.share.upload") {
      const receipt = uploads.receive(input as MethodParams["remote.share.upload"]);
      if (receipt.attachmentId) options.audit(method, "allowed");
      return receipt;
    }
    if (isOfflinePhoneMethod(method)) {
      if (!options.offline) throw new RpcError(RpcErrorCodes.unsupported, "offline_unavailable");
      return options.offline(method, input, requestSignal);
    }
    if (method === "remote.phoneData.state") {
      return (
        options.phoneData?.(input as MethodParams["remote.phoneData.state"]) ?? {
          ok: true as const,
        }
      );
    }
    const copied =
      input && typeof input === "object" ? ({ ...input } as Record<string, unknown>) : input;
    const params = options.guard ? await options.guard(method, copied, requestSignal) : copied;
    // A guard may finish concurrently with cancellation. Never dispatch the guarded write after
    // that point, even when the adapter completing the guard read did not reject on abort.
    requestSignal.throwIfAborted();
    // Run records reach the phone for the last 3 days only, in capped pages.
    if (isRecordMethod(method)) {
      const now = Date.now();
      const clamped = clampRecordParams(method, params, now);
      return clampRecordResult(
        method,
        await options.kernel.dispatch(method, clamped, {
          deviceId: options.deviceId,
          signal: requestSignal,
        }),
        now,
      );
    }
    if (method !== "chat.send")
      return options.kernel.dispatch(method, params, {
        deviceId: options.deviceId,
        signal: requestSignal,
      });
    const payload = params as Record<string, unknown>;
    const clientId = String(payload.clientMessageId);
    delete payload.clientMessageId;
    // Only files this phone uploaded in this session; they travel on as ordinary inline
    // attachments, so the kernel's own limits and checks apply.
    const ids = Array.isArray(payload.attachmentIds) ? (payload.attachmentIds as string[]) : [];
    const shared = ids.length ? uploads.take(ids) : [];
    // A re-upload after a lost acknowledgement gets new IDs but the same content digests.
    const stable = shared.length
      ? { ...payload, attachmentIds: shared.map((file) => file.digest) }
      : payload;
    // Fingerprints are private; neither text nor its hash is an authorization source.
    const fingerprint = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    const receipt = options.receipts.begin(options.deviceId, clientId, fingerprint);
    if (!receipt.fresh) {
      uploads.release(ids);
      return receipt.result;
    }
    if (shared.length) {
      delete payload.attachmentIds;
      payload.attachments = shared.map((file) => file.input);
    }
    try {
      // Proposal 5: the phone's request ends when its path switches or drops; the send itself
      // must still finish (or refuse) so its receipt settles. A receipt left pending made every
      // retry of that message "uncertain" for good, which the phone showed as a lost send.
      const result = await options.kernel.dispatch(method, payload, {
        deviceId: options.deviceId,
        signal: AbortSignal.timeout(SEND_SETTLE_MS),
      });
      options.receipts.complete(options.deviceId, clientId, result);
      return result;
    } catch (error) {
      // The kernel stores a message in one transaction at the end of a send, so a refusal it
      // names (invalid, busy, no model, stopping) stored nothing: the same ID may be sent again.
      // An internal failure or a timeout stays uncertain, never permission to replay.
      if (
        error instanceof RpcError &&
        error.code !== RpcErrorCodes.internal &&
        error.code !== RpcErrorCodes.timeout
      )
        options.receipts.release(options.deviceId, clientId);
      throw error;
    } finally {
      // A refused send must not hold the session's upload budget for 10 minutes: the phone
      // uploads again on its retry, and the same content fingerprints the same.
      uploads.release(ids);
    }
  }
  for (const method of phoneMethods) {
    if (method === "events.resume") continue;
    peer.handle(method, async (params, { signal }) => {
      const work = execute(method, params, signal);
      tasks.add(work);
      try {
        const value = Methods[method].result.parse(await work);
        if (!quiet(method)) options.audit(method, "allowed", params);
        return value as never;
      } catch (error) {
        options.audit(method, "failed", params);
        throw error;
      } finally {
        tasks.delete(work);
      }
    });
  }
  return {
    /** A desktop → phone call on this session; the phone answers or refuses it. */
    call: (async (method, params, signal, timeoutMs) => {
      if (options.phoneCapabilityAllowed && !options.phoneCapabilityAllowed(method))
        throw new RpcError(RpcErrorCodes.unsupported, "capability_off");
      const guarded = AbortSignal.any([
        signal,
        options.signal,
        ...(options.phoneCapabilitySignal ? [options.phoneCapabilitySignal()] : []),
      ]);
      const result = await caller.call(method, params, guarded, timeoutMs);
      guarded.throwIfAborted();
      if (options.phoneCapabilityAllowed && !options.phoneCapabilityAllowed(method))
        throw new RpcError(RpcErrorCodes.unsupported, "capability_off");
      return result;
    }) as typeof caller.call,
    emit(method: string, payload: unknown, online: boolean) {
      if (!isPhoneEvent(method)) return;
      if (online) {
        catchUp();
        peer.emit(method as keyof typeof Events, payload as never);
      } else if (method !== "chat.delta" && method !== "chat.tool" && method !== "chat.activity") {
        options.buffer.append(method, payload);
        behind = true;
      }
    },
    /** The phone is back in the foreground on this session: send what it missed meanwhile. */
    catchUp,
    async close() {
      caller.close();
      peer.dispose();
      await Promise.allSettled([...tasks]);
      // After the requests: a takeover still starting must be handed back as well.
      await options.browser.close();
      pending.clear();
      resumeAfter.clear();
      previews.clear();
      uploads.clear();
    },
  };
}
