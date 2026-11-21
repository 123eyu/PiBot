import { z } from "zod";

/** Shapes every method/event table shares; the aggregated tables live in `@pibot/protocol`. */
export type MethodTable = Record<
  string,
  { params: z.ZodType; result: z.ZodType; timeoutMs?: number }
>;
export type EventTable = Record<string, z.ZodType>;
export type Params<M extends MethodTable, K extends keyof M> = z.input<M[K]["params"]>;
export type Result<M extends MethodTable, K extends keyof M> = z.output<M[K]["result"]>;
export type Payload<E extends EventTable, K extends keyof E> = z.output<E[K]>;
export type RuntimeEventEnvelope<E extends EventTable> = {
  [K in keyof E & string]: {
    jsonrpc: "2.0";
    method: K;
    params: { seq: number; payload: z.output<E[K]> };
  };
}[keyof E & string];

/** Builds the replay envelope at a composition root without importing an aggregate table. */
export function createEventEnvelopeSchema<E extends EventTable>(
  events: E,
): z.ZodType<RuntimeEventEnvelope<E>> {
  const members = Object.entries(events).map(([method, payload]) =>
    z.strictObject({
      jsonrpc: z.literal("2.0"),
      method: z.literal(method),
      params: z.strictObject({ seq: z.number().int().positive(), payload }),
    }),
  );
  if (!members.length) throw new Error("Event table must not be empty");
  return z.discriminatedUnion("method", members as never) as z.ZodType<RuntimeEventEnvelope<E>>;
}

export interface Port {
  post(message: unknown, transfer?: unknown[]): void;
  onMessage(listener: (message: unknown) => void): () => void;
  /** Optional local transport scheduling; ordinary JSON-RPC ports remain unchanged. */
  postRequest?(message: unknown, deadline: number): void;
  cancelRequest?(id: string): void;
  onRequestCancel?(listener: (id: string) => void): () => void;
  sendStream?(message: z.input<typeof PortStreamMessageSchema>): void;
  onRequestStream?(
    listener: (message: z.output<typeof PortStreamMessageSchema>) => void,
  ): () => void;
  /** Fires for local disposal and remote transport closure. */
  onClose?(listener: () => void): () => void;
  dispose?(): void;
}

const PortRequestIdSchema = z.string().min(1).max(128);
export const PortCancelMessageSchema = z.strictObject({
  $pibot: z.literal("rpc.cancel"),
  id: PortRequestIdSchema,
});
/** Request-scoped streaming control frame. Business events never enter this channel. */
export const PortStreamMessageSchema = z.strictObject({
  $pibot: z.literal("rpc.stream"),
  id: PortRequestIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  done: z.boolean(),
  chunk: z.unknown().optional(),
});
export const PortReservedMessageSchema = z.discriminatedUnion("$pibot", [
  PortCancelMessageSchema,
  PortStreamMessageSchema,
]);

export const RpcErrorCodes = {
  draftUnavailable: -32060,
  draftResolved: -32061,
  draftExpired: -32062,
  draftChanged: -32063,
  draftContentInvalid: -32064,
  draftDenied: -32065,
  draftExecutionFailed: -32066,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  timeout: -32000,
  closed: -32001,
  resumeUnavailable: -32002,
  /** chat.send while the Bot has no usable model (a temporary chat.error no_model is also emitted). */
  noModel: -32010,
  /** Business resource or transport capacity exhausted. */
  busy: -32011,
  /** Runner refused an idempotency key outside its signed seven-day acceptance window. */
  idempotencyExpired: -32028,
  /** Runner could not obtain the brain's final dispatch confirmation. */
  dispatchDenied: -32029,
  /** The OS secret store (safeStorage) is unavailable, so keys cannot be saved or read. */
  secretsUnavailable: -32012,
  imageUnsupported: -32013,
  attachmentInvalid: -32014,
  scannedPdfUnsupported: -32015,
  attachmentConversion: -32016,
  runLogMissing: -32017,
  runLogInvalid: -32018,
  unsupported: -32019,
  /** Another non-archived Bot already has this name (trimmed, NFKC, case-folded). */
  botNameTaken: -32020,
  /** A group @mention that does not resolve to exactly one member (pick it from the @ list). */
  mentionUnresolved: -32021,
  /** Connector/import snapshot no longer matches; reload before attempting a new operation. */
  connectorStale: -32022,
  /** A configured connector is not usable yet (disabled, setup, auth or draining). */
  connectorUnavailable: -32023,
  /** Preview expired, changed source or rejected import format. No source content in messages. */
  pluginImportInvalid: -32024,
  /** Import already committed; a retry that asks to enable would guess at the user's intent. */
  pluginImportCommitted: -32025,
  secretExists: -32026,
  secretStale: -32027,
  /** The runner is still confirming an earlier command's cleanup, so it refuses to start new ones. */
  runnerCleanupUnconfirmed: -32030,
  /** A momentary runner-side monitor fault (process snapshot): the command was stopped part-way and may have partially run; check state before retrying. */
  runnerTransient: -32031,
  /** The caller cancelled the work; it is not a failure and retrying is not implied. */
  cancelled: -32032,
  /** A saved routine has unreadable or uncheckable consent; edit its preauthorizations. */
  routineReauthorizationRequired: -32033,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
    this.name = "RpcError";
  }
}

export interface Peer<M extends MethodTable, E extends EventTable> {
  call<K extends keyof M>(
    method: K,
    params: Params<M, K>,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      streamSchema?: z.ZodType;
      onStream?(chunk: unknown): void;
    },
  ): Promise<Result<M, K>>;
  handle<K extends keyof M>(
    method: K,
    fn: (
      params: Params<M, K>,
      context: { signal: AbortSignal; stream?(chunk: unknown): void },
    ) => Promise<Result<M, K>>,
  ): void;
  emit<K extends keyof E>(event: K, payload: Payload<E, K>): void;
  on<K extends keyof E>(
    event: K,
    fn: (payload: Payload<E, K>, meta: { seq: number }) => void,
  ): () => void;
  dispose(): void;
}

export interface BufferedEvent {
  jsonrpc: "2.0";
  method: string;
  params: { seq: number; payload: unknown };
}

/** Keep this buffer when replacing a port so event sequences survive reconnection. */
export class EventBuffer<E extends EventTable> {
  private sequence = 0;
  private readonly history: BufferedEvent[] = [];
  private readonly events: E;
  private readonly capacity: number;

  constructor(events: E, capacity = 1000) {
    this.events = events;
    this.capacity = capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Event buffer capacity must be a positive safe integer");
    }
  }

  append(method: string, payload: unknown): BufferedEvent {
    const schema = own(this.events, method);
    const parsed = schema?.safeParse(payload);
    if (!parsed?.success) throw invalidParams();
    if (this.sequence === Number.MAX_SAFE_INTEGER)
      throw new RpcError(-32603, "Event sequence exhausted");
    const snapshot = structuredClone(parsed.data);
    const message: BufferedEvent = {
      jsonrpc: "2.0",
      method,
      params: { seq: ++this.sequence, payload: snapshot },
    };
    this.history.push(message);
    if (this.history.length > this.capacity) this.history.shift();
    return structuredClone(message);
  }

  resume(afterSeq: number): BufferedEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw invalidParams();
    const first = this.history[0]?.params.seq ?? this.sequence + 1;
    if (afterSeq > this.sequence || afterSeq < first - 1) {
      throw new RpcError(
        RpcErrorCodes.resumeUnavailable,
        "Event history unavailable; reload state",
      );
    }
    return structuredClone(this.history.filter((message) => message.params.seq > afterSeq));
  }
}

const idSchema = z.union([z.string(), z.number().int().safe(), z.null()]);
type RequestId = z.infer<typeof idSchema>;
const requestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: idSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const successSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  result: z.unknown(),
});
function rpcErrorSchema(withData: boolean) {
  return z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: idSchema.nullable(),
    error: z.strictObject({
      code: z.number().int(),
      message: z.string(),
      ...(withData ? { data: z.unknown().optional() } : {}),
    }),
  });
}
const eventParamsSchema = z.strictObject({
  seq: z.number().int().positive().safe(),
  payload: z.unknown(),
});
const resumeParamsSchema = z.strictObject({ afterSeq: z.number().int().nonnegative().safe() });
const invalidParams = () => new RpcError(RpcErrorCodes.invalidParams, "Schema validation failed");
const invalidResult = () => new RpcError(RpcErrorCodes.internal, "Result validation failed");

function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

interface Pending {
  schema: z.ZodType;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
  onStream?(chunk: unknown): void;
  streamSchema?: z.ZodType;
  nextSequence: number;
  streamDone: boolean;
}

export interface PeerErrorInfo {
  method: string;
  stage: "params" | "result" | "handler";
  /**
   * Present for params / result validation failures: the field paths, codes and refused extra
   * keys, never values. A strict schema rejecting a field that an internal type added shows up
   * here by name instead of as a bare internal error.
   */
  issues?: PeerValidationIssue[];
}

export interface PeerValidationIssue {
  /** Dotted path; empty string for the root value. */
  path: string;
  code: string;
  /** Keys a strict object refused. */
  keys?: string[];
}

const MAX_REPORTED_ISSUES = 5;
const MAX_REPORTED_KEYS = 8;

function validationIssues(error: z.ZodError): PeerValidationIssue[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    code: issue.code,
    ...(issue.code === "unrecognized_keys" ? { keys: issue.keys.slice(0, MAX_REPORTED_KEYS) } : {}),
  }));
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new RangeError("Invalid RPC timeout");
  return timeoutMs;
}

export function createPeer<M extends MethodTable, E extends EventTable>(
  port: Port,
  opts: {
    methods: M;
    events: E;
    timeoutMs?: number;
    eventBuffer?: EventBuffer<E>;
    /** Opt-in codec; callers remain responsible for negotiating with strict older peers. */
    errorDataSchema?: z.ZodType;
    onError?(info: PeerErrorInfo): void;
  },
): Peer<M, E> {
  const timeoutMs = validateTimeout(opts.timeoutMs ?? 30_000);
  const errorSchema = rpcErrorSchema(opts.errorDataSchema !== undefined);
  const buffer = opts.eventBuffer ?? new EventBuffer(opts.events);
  const handlers = new Map<
    string,
    (
      params: unknown,
      context: { signal: AbortSignal; stream?(chunk: unknown): void },
    ) => Promise<unknown>
  >();
  const listeners = new Map<string, Set<(payload: unknown, meta: { seq: number }) => void>>();
  const pending = new Map<RequestId, Pending>();
  const activeRequests = new Map<string, AbortController>();
  const requestControllers = new Set<AbortController>();
  let closed = false;

  function assertOpen() {
    if (closed) throw new RpcError(RpcErrorCodes.closed, "Peer disposed");
  }

  function sendError(id: RequestId | null, error: RpcError) {
    if (closed) return;
    const data = opts.errorDataSchema?.safeParse(error.data);
    port.post({
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(data?.success ? { data: data.data } : {}),
      },
    });
  }

  async function receiveRequest(request: z.infer<typeof requestSchema>) {
    const { id, method, params } = request;
    const schema = own(opts.methods, method);
    if (!schema) {
      if (id !== undefined) sendError(id, new RpcError(-32601, "Method not found"));
      return;
    }
    if (typeof id === "string" && activeRequests.has(id)) {
      sendError(id, new RpcError(RpcErrorCodes.busy, "Request already active"));
      return;
    }
    const controller = new AbortController();
    let streamSequence = 0;
    requestControllers.add(controller);
    if (typeof id === "string") activeRequests.set(id, controller);
    let stage: PeerErrorInfo["stage"] = "params";
    let issues: PeerValidationIssue[] | undefined;
    try {
      const parsed = schema.params.safeParse(params);
      if (!parsed.success) {
        issues = validationIssues(parsed.error);
        throw invalidParams();
      }
      stage = "handler";
      let result: unknown;
      if (method === "events.resume") {
        const resume = resumeParamsSchema.safeParse(parsed.data);
        if (!resume.success) throw invalidParams();
        result = buffer.resume(resume.data.afterSeq);
      } else {
        const handler = handlers.get(method);
        if (!handler) throw new RpcError(-32601, "Method not found");
        result = await handler(parsed.data, {
          signal: controller.signal,
          ...(port.sendStream
            ? {
                stream(chunk: unknown) {
                  controller.signal.throwIfAborted();
                  if (typeof id !== "string") return;
                  port.sendStream?.({
                    $pibot: "rpc.stream",
                    id,
                    sequence: streamSequence++,
                    done: false,
                    chunk,
                  });
                },
              }
            : {}),
        });
      }
      if (controller.signal.aborted) throw new RpcError(RpcErrorCodes.closed, "RPC cancelled");
      stage = "result";
      const validated = schema.result.safeParse(result);
      if (!validated.success) {
        issues = validationIssues(validated.error);
        throw invalidResult();
      }
      if (typeof id === "string" && port.sendStream)
        port.sendStream({ $pibot: "rpc.stream", id, sequence: streamSequence, done: true });
      if (id !== undefined && !closed) port.post({ jsonrpc: "2.0", id, result: validated.data });
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          opts.onError?.({ method, stage, ...(issues ? { issues } : {}) });
        } catch {
          // Diagnostics must not prevent an RPC error response.
        }
      }
      if (id !== undefined) {
        sendError(
          id,
          controller.signal.aborted
            ? new RpcError(RpcErrorCodes.closed, "RPC cancelled")
            : error instanceof RpcError
              ? error
              : new RpcError(-32603, "Internal error"),
        );
      }
    } finally {
      requestControllers.delete(controller);
      if (typeof id === "string" && activeRequests.get(id) === controller)
        activeRequests.delete(id);
    }
  }

  function receive(message: unknown) {
    if (closed) return;
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      sendError(null, new RpcError(-32600, "Invalid request"));
      return;
    }
    if ("method" in message) {
      const request = requestSchema.safeParse(message);
      if (!request.success) {
        const id = "id" in message ? idSchema.safeParse(message.id) : undefined;
        sendError(id?.success ? id.data : null, new RpcError(-32600, "Invalid request"));
        return;
      }
      if (request.data.id === undefined && own(opts.events, request.data.method)) {
        const params = eventParamsSchema.safeParse(request.data.params);
        const schema = own(opts.events, request.data.method);
        const payload = params.success ? schema?.safeParse(params.data.payload) : undefined;
        // JSON-RPC notifications cannot receive error responses.
        if (!params.success || !payload?.success) return;
        for (const listener of listeners.get(request.data.method) ?? []) {
          try {
            listener(payload.data, { seq: params.data.seq });
          } catch {
            /* One subscriber must not break transport. */
          }
        }
        return;
      }
      // A failing transport cannot turn the subscription callback into an unhandled rejection.
      void receiveRequest(request.data).catch(() => {});
      return;
    }
    const id = "id" in message ? idSchema.safeParse(message.id) : undefined;
    if (!id?.success) {
      if (!("result" in message) && !("error" in message))
        sendError(null, new RpcError(-32600, "Invalid request"));
      return;
    }
    const call = pending.get(id.data);
    if (!call) {
      if (!("result" in message) && !("error" in message))
        sendError(id.data, new RpcError(-32600, "Invalid request"));
      return;
    }
    pending.delete(id.data);
    clearTimeout(call.timer);
    call.cleanup();
    const error = errorSchema.safeParse(message);
    if (error.success) {
      const { code, message } = error.data.error;
      const data = opts.errorDataSchema?.safeParse(
        "data" in error.data.error ? error.data.error.data : undefined,
      );
      // A malformed extension must not erase the coarse RPC error.
      call.reject(new RpcError(code, message, data?.success ? data.data : undefined));
      return;
    }
    const response = successSchema.safeParse(message);
    const parsed =
      response.success && Object.hasOwn(message, "result")
        ? call.schema.safeParse(response.data.result)
        : undefined;
    if (!parsed?.success) call.reject(invalidResult());
    else if (call.onStream && !call.streamDone)
      call.reject(new RpcError(RpcErrorCodes.invalidRequest, "RPC stream ended without done"));
    else call.resolve(parsed.data);
  }

  const unsubscribe = port.onMessage(receive);
  const unsubscribeCancel =
    port.onRequestCancel?.((id) => {
      const parsed = PortRequestIdSchema.safeParse(id);
      if (parsed.success) activeRequests.get(parsed.data)?.abort();
    }) ?? (() => {});
  const unsubscribeStream =
    port.onRequestStream?.((message) => {
      const call = pending.get(message.id);
      if (!call) return;
      if (call.streamDone || message.sequence !== call.nextSequence) {
        pending.delete(message.id);
        clearTimeout(call.timer);
        call.cleanup();
        call.reject(new RpcError(RpcErrorCodes.invalidRequest, "Invalid RPC stream sequence"));
        try {
          port.cancelRequest?.(message.id);
        } catch {
          // The sequence failure is already closed locally; transport cleanup owns the remote.
        }
        return;
      }
      call.nextSequence++;
      if (message.done) {
        call.streamDone = true;
        return;
      }
      const chunk = call.streamSchema?.safeParse(message.chunk);
      if (chunk && !chunk.success) {
        pending.delete(message.id);
        clearTimeout(call.timer);
        call.cleanup();
        call.reject(invalidResult());
        try {
          port.cancelRequest?.(message.id);
        } catch {
          // The invalid stream is already closed locally; transport cleanup owns the remote.
        }
        return;
      }
      try {
        call.onStream?.(chunk?.data ?? message.chunk);
      } catch {
        // A consumer callback cannot corrupt the request/response transport.
      }
    }) ?? (() => {});
  let unsubscribeClose = () => {};
  function close(disposePort: boolean) {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeCancel();
    unsubscribeStream();
    unsubscribeClose();
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    activeRequests.clear();
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.cleanup();
      call.reject(new RpcError(RpcErrorCodes.closed, "Peer disposed"));
    }
    pending.clear();
    handlers.clear();
    listeners.clear();
    if (disposePort) port.dispose?.();
  }
  unsubscribeClose = port.onClose?.(() => close(false)) ?? (() => {});
  return {
    async call(method, params, options) {
      assertOpen();
      options?.signal?.throwIfAborted();
      const schema = own(opts.methods, String(method));
      const deadline = validateTimeout(options?.timeoutMs ?? schema?.timeoutMs ?? timeoutMs);
      const expiresAt = Date.now() + Math.ceil(deadline);
      if (!schema) throw new RpcError(-32601, "Method not found");
      const parsed = schema.params.safeParse(params);
      if (!parsed.success) throw invalidParams();
      if (Date.now() >= expiresAt) throw new RpcError(RpcErrorCodes.timeout, "RPC timed out");
      const id = globalThis.crypto.randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const signal = options?.signal;
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const cancel = (error: unknown) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          cleanup();
          reject(error);
          try {
            port.cancelRequest?.(id);
          } catch {
            // A closed transport cannot retract a remote call; the owner still drains it.
          }
        };
        const abort = () => cancel(signal?.reason);
        const timer = setTimeout(
          () => {
            cancel(new RpcError(RpcErrorCodes.timeout, "RPC timed out"));
          },
          Math.max(1, expiresAt - Date.now()),
        );
        pending.set(id, {
          schema: schema.result,
          resolve,
          reject,
          timer,
          cleanup,
          onStream: options?.onStream,
          streamSchema: options?.streamSchema,
          nextSequence: 0,
          streamDone: false,
        });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const message = {
            jsonrpc: "2.0",
            id,
            method,
            ...(parsed.data === undefined ? {} : { params: parsed.data }),
          };
          if (port.postRequest) port.postRequest(message, expiresAt);
          else port.post(message);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          cleanup();
          reject(error);
        }
      }) as Promise<Result<M, typeof method>>;
    },
    handle(method, fn) {
      assertOpen();
      if (!own(opts.methods, String(method))) throw new RpcError(-32601, "Method not found");
      if (method === "events.resume") throw new Error("events.resume is managed by the peer");
      handlers.set(
        String(method),
        fn as (
          params: unknown,
          context: { signal: AbortSignal; stream?(chunk: unknown): void },
        ) => Promise<unknown>,
      );
    },
    emit(event, payload) {
      assertOpen();
      port.post(buffer.append(String(event), payload));
    },
    on(event, fn) {
      // A disposed Peer never delivers events again. Throwing here crashed phone screens whose
      // subscribe effect ran just after a path rebind retired the old Peer (v0.0.2 phone test);
      // the screen re-subscribes when the new Peer arrives.
      if (closed) return () => {};
      if (!own(opts.events, String(event))) throw new RpcError(-32601, "Event not found");
      const callbacks = listeners.get(String(event)) ?? new Set();
      const callback = fn as (payload: unknown, meta: { seq: number }) => void;
      callbacks.add(callback);
      listeners.set(String(event), callbacks);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        callbacks.delete(callback);
        if (callbacks.size === 0) listeners.delete(String(event));
      };
    },
    dispose() {
      close(true);
    },
  };
}
