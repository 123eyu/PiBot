// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: rewritten: one catalog across servers that refuses colliding tool names, and a shutdown that waits for pending connects and keeps ownership when close fails.
// Upstream file: host-managed.ts
// host-managed.ts - MCP calls for an embedding application that owns the
// transport, credentials, approval, dispatch record, and instance lifetime.
//
// Unlike the ordinary extension, this profile reads no config files, never
// touches OAuth or the keyring, registers no commands, UI, or proxy tools, and
// never reconnects, recovers a session, or resends a tools/call request.
//
// Pi Bot modifications (vs upstream 5.3.1):
// - Approval is owned by the Pi Bot policy layer, which permits before calling;
//   upstream's pi-events approval broker (requestBrokerApproval) is cut.
// - The catalog is dynamic and aggregated across servers: tools/list_changed
//   re-lists and republishes the merged catalog through onCatalogChanged
//   instead of retiring tools and demanding a new session. Cross-server name
//   collisions are re-validated on every publication; a collision keeps the
//   previously published catalog. Pi Bot's pool gates admission per
//   connection generation.
// - close() drops upstream's 5-second Promise.race: the Pi Bot pool awaits the
//   real in-flight drain and keeps its stopping state until close settles.
//   Transport factories that resolve late are tracked and closed before close
//   reports completion, and a failed transport close is reported (fixed
//   message, raw cause dropped) with ownership retained so close() can be
//   retried; closed ≠ drained.
// - MCP resource reads (linkedResource/readResource) and the pi extension
//   factory / direct tool registration are cut for round 1 (tools only).
// - Client name is "pibot-connector-<server>" instead of "pi-mcp-<server>".
import { randomUUID } from "node:crypto";
import {
  type CallToolResult,
  Client,
  type JsonSchemaType,
  type JsonSchemaValidator,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { abortable } from "./abort.ts";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import {
  guardedMcpDetails,
  guardMcpOutput,
  resolveMcpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { resolveMcpResultContent } from "./tool-registrar.ts";
import { formatToolName } from "./types.ts";
import { normalizeToolArguments, stableStringify, withToolCallIdMeta } from "./utils.ts";

export interface HostManagedMcpServer {
  /**
   * Called once by ready(). Return an unconnected transport. It must not carry
   * an auth provider or any behavior that replays a request; the adapter sends
   * each tools/call at most once on its own layer only. The factory must honor
   * the abort signal: a factory that never settles also keeps close() waiting,
   * because close() cannot claim drained while a transport may still appear.
   */
  createTransport(context: { server: string; signal: AbortSignal }): Transport | Promise<Transport>;
  /** MCP tool names to expose. Omit to expose every tool the server lists. */
  tools?: readonly string[];
}

export interface HostManagedMcpToolCall {
  readonly server: string;
  /** MCP tool name. */
  readonly tool: string;
  /** Pi Bot tool name the model called. */
  readonly toolName: string;
  readonly toolCallId: string;
  /** Opaque identity of the connection this call is bound to. */
  readonly connectionId: string;
  /** Deep-frozen arguments; exactly what dispatch() sends. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Deep-frozen input schema that was discovered. */
  readonly inputSchema: Tool["inputSchema"];
  /** Aborted by the caller or by close(). */
  readonly signal: AbortSignal;
  /**
   * Send the tools/call request once and return the validated raw result.
   * Rejects with HostManagedMcpError. Calling it twice throws.
   */
  dispatch(): Promise<CallToolResult>;
}

export interface HostManagedMcpAdapterOptions {
  servers: Record<string, HostManagedMcpServer>;
  /**
   * Runs after the Pi Bot policy permit for every tool call. Record the call,
   * invoke `call.dispatch()` at most once, and return the result to present to
   * the model through the normal output guard.
   */
  onToolCall(call: HostManagedMcpToolCall): Promise<CallToolResult>;
  /** Per-request timeout in milliseconds. The MCP SDK default applies when omitted. */
  requestTimeoutMs?: number;
  /** Initial handshake and catalog only; lifetime signal still owns the total open budget. */
  openTimeoutMs?: number;
  /** Publishes a refreshed catalog after tools/list_changed. Optional. */
  onCatalogChanged?(server: string, tools: readonly CatalogTool[]): void;
}

export interface HostManagedMcpAdapter {
  /** Connect every server and build the tool catalog. Memoized; rejects and closes the adapter on any failure. */
  ready(): Promise<void>;
  /**
   * Refuse new calls, abort in-flight calls, wait for pending transport
   * factories and in-flight connect attempts, then close every transport.
   * Resolves only when all owned resources actually drained; a transport that
   * failed to close is reported with a fixed error and close() can be retried.
   */
  close(): Promise<void>;
  /** Current catalog; empty until ready() resolves. Rebuilt in place on tools/list_changed. */
  catalog(): readonly CatalogTool[];
  /**
   * Execute one MCP tool call end to end (arguments normalization, one
   * dispatch, output-schema validation, output guard). `toolName` is the
   * prefixed CatalogTool.toolName.
   */
  callTool(
    server: string,
    toolName: string,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    /** Extra request `_meta` entries. */
    meta?: Readonly<Record<string, string>>,
  ): Promise<ToolResult>;
}

/**
 * - `not_sent`: the request never left the adapter; the tool did not run.
 * - `may_have_run`: the request was sent and its outcome is unknown.
 * - `server_error`: the server answered with a JSON-RPC error.
 * - `invalid_result`: the server answered, but the result failed validation.
 */
export type HostManagedMcpDelivery =
  | "not_sent"
  | "may_have_run"
  | "server_error"
  | "invalid_result";

const DELIVERY_MESSAGES: Record<HostManagedMcpDelivery, string> = {
  not_sent: "the request was not sent",
  may_have_run: "the request failed after it was sent; the tool may have run",
  server_error: "the server returned an error response",
  invalid_result: "the server returned an invalid result; the tool may have run",
};

/** Fixed-message dispatch failure. The raw error is kept only as `cause`. */
export class HostManagedMcpError extends Error {
  readonly delivery: HostManagedMcpDelivery;
  readonly server: string;
  readonly protocolCode?: number;

  constructor(
    delivery: HostManagedMcpDelivery,
    server: string,
    options: { cause?: unknown; protocolCode?: number } = {},
  ) {
    super(
      `MCP server "${server}": ${DELIVERY_MESSAGES[delivery]}`,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "HostManagedMcpError";
    this.delivery = delivery;
    this.server = server;
    if (options.protocolCode !== undefined) this.protocolCode = options.protocolCode;
  }
}

export interface CatalogTool {
  readonly server: string;
  readonly toolName: string;
  readonly definition: Tool;
  readonly fingerprint: string;
  readonly sdkDefinition: Tool;
  readonly validateOutput: JsonSchemaValidator<unknown> | undefined;
}

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: Record<string, unknown>;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function classifyDispatchError(server: string, cause: unknown): HostManagedMcpError {
  if (cause instanceof HostManagedMcpError) return cause;
  // Output-schema validation runs in this module, so a ProtocolError here is a
  // JSON-RPC error response from the server.
  if (cause instanceof ProtocolError)
    return new HostManagedMcpError("server_error", server, { cause, protocolCode: cause.code });
  if (cause instanceof SdkError && cause.code === SdkErrorCode.InvalidResult) {
    return new HostManagedMcpError("invalid_result", server, { cause });
  }
  if (cause instanceof SdkError && cause.code === SdkErrorCode.NotConnected) {
    return new HostManagedMcpError("not_sent", server, { cause });
  }
  return new HostManagedMcpError("may_have_run", server, { cause });
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function dispatchFailureResult(tool: CatalogTool, error: HostManagedMcpError): ToolResult {
  const name = tool.definition.name;
  const details: Record<string, unknown> = {
    error: error.delivery,
    server: tool.server,
    tool: name,
  };
  const unknownOutcome = "Do not retry automatically; check its effects first.";
  switch (error.delivery) {
    case "not_sent":
      return textResult(
        `MCP tool "${name}" on server "${tool.server}" was not run: the request was not sent because the call was cancelled or the MCP connection is closed.`,
        details,
      );
    case "may_have_run":
      return textResult(
        `MCP tool "${name}" on server "${tool.server}" failed after the request was sent, so it may have run. ${unknownOutcome}`,
        details,
      );
    case "server_error": {
      const code = error.protocolCode !== undefined ? ` (JSON-RPC code ${error.protocolCode})` : "";
      if (error.protocolCode !== undefined) details.protocolCode = error.protocolCode;
      return textResult(
        `MCP server "${tool.server}" returned an error for tool "${name}"${code}.`,
        details,
      );
    }
    case "invalid_result":
      return textResult(
        `MCP tool "${name}" on server "${tool.server}" returned an invalid result, so it may have run. ${unknownOutcome}`,
        details,
      );
  }
}

/** A close attempt marks the transport; a failed close unmarks it so close() can be retried. */
const closeAttempted = new WeakSet<Transport>();

async function closeTransport(transport: Transport): Promise<void> {
  try {
    if (!closeAttempted.has(transport)) {
      closeAttempted.add(transport);
      await transport.close();
    }
  } catch (cause) {
    closeAttempted.delete(transport);
    throw cause;
  }
}

interface TrackedFactory {
  /** Resolves to the transport, or rejects when the factory itself failed. */
  readonly source: Promise<Transport>;
  /** Resolves once the adapter decided who owns the transport (or never will). */
  readonly handoff: Promise<void>;
  /** Closes a late-delivered un-adopted transport; failures join the retry set. */
  readonly task: Promise<void>;
  /** Transfers ownership to the connect attempt. */
  markAdopted(): void;
  /** Releases the decision without transferring ownership (close started). */
  release(): void;
}

export function createHostManagedMcpAdapter(
  options: HostManagedMcpAdapterOptions,
): HostManagedMcpAdapter {
  const servers = Object.entries(options.servers);
  const timeout =
    options.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : undefined;
  const guardOptions = resolveMcpOutputGuardOptions(undefined);
  const lifetime = new AbortController();
  const connections = new Map<string, Connection>();
  const inFlight = new Set<Promise<ToolResult>>();
  /** One entry per transport factory; close() waits for every entry to settle. */
  const pendingFactories = new Set<TrackedFactory>();
  /** Connect attempts in flight, including their transport adoption and cleanup. */
  const activeConnects = new Set<Promise<void>>();
  /** Transports that failed to close; ownership is retained for a retried close(). */
  let failedCloses: Transport[] = [];
  let catalog: readonly CatalogTool[] = [];
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const requestOptions = (signal: AbortSignal) =>
    timeout !== undefined ? { signal, timeout } : { signal };

  function trackFactory(
    server: string,
    factory: HostManagedMcpServer["createTransport"],
  ): TrackedFactory {
    let adopted = false;
    let release: () => void = () => {};
    const handoff = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = Promise.resolve().then(() => factory({ server, signal: lifetime.signal }));
    const task = (async () => {
      let transport: Transport;
      try {
        transport = await source;
      } catch {
        // The factory created nothing; there is no resource to own.
        return;
      }
      await handoff;
      if (adopted) return; // The connect attempt owns closing it.
      // Un-adopted transport (close started, or the attempt failed before
      // adoption): the tracker is the last owner, so it closes the resource.
      try {
        await closeTransport(transport);
      } catch {
        failedCloses.push(transport);
      }
    })();
    const tracked: TrackedFactory = {
      source,
      handoff,
      task,
      markAdopted() {
        adopted = true;
        release();
      },
      release,
    };
    pendingFactories.add(tracked);
    void task.finally(() => pendingFactories.delete(tracked)).catch(() => {});
    return tracked;
  }

  /** Merges every connection's selection; refuses to publish a cross-server name collision. */
  function publishCatalog():
    | { ok: true }
    | { ok: false; owner: CatalogTool; duplicate: CatalogTool } {
    const tools: CatalogTool[] = [];
    const owners = new Map<string, CatalogTool>();
    for (const connection of connections.values()) {
      for (const tool of connection.selected ?? []) {
        const owner = owners.get(tool.toolName);
        if (owner) return { ok: false, owner, duplicate: tool };
        owners.set(tool.toolName, tool);
        tools.push(tool);
      }
    }
    catalog = Object.freeze(tools);
    return { ok: true };
  }

  // A notification revokes the old schema before any await. A failed refresh must
  // not leave a former read-only definition callable against the changed server.
  function requestCatalogRefresh(
    connection: Connection,
    definition: HostManagedMcpServer,
    server: string,
  ): void {
    if (closed || !connection.open) return;
    connection.refreshRequested = true;
    if (!connection.selected) return;
    connection.selected = [];
    const invalidated = publishCatalog();
    if (invalidated.ok) options.onCatalogChanged?.(server, []);
    if (connection.refresh) return;
    connection.refresh = (async () => {
      while (connection.refreshRequested) {
        connection.refreshRequested = false;
        try {
          const { tools } = await connection.client.listTools(undefined, {
            ...requestOptions(lifetime.signal),
            cacheMode: "refresh",
          });
          if (closed || !connection.open) return;
          // A newer notification invalidated this walk too. Only its replacement may publish.
          if (connection.refreshRequested) continue;
          const next = buildCatalogTools(server, definition, tools, connection.validators);
          connection.selected = next;
          const published = publishCatalog();
          if (published.ok) options.onCatalogChanged?.(server, next);
          // A collision leaves this server revoked; the next notification retries.
          if (!published.ok) connection.selected = [];
        } catch {
          // Remain revoked. A later notification or explicit reconnect may retry discovery.
        }
      }
      connection.refresh = undefined;
    })();
  }

  function buildCatalogTools(
    server: string,
    definition: HostManagedMcpServer,
    listed: Tool[],
    validators: ReturnType<typeof createJsonSchemaValidator>,
  ): CatalogTool[] {
    const byName = new Map<string, Tool>();
    for (const tool of listed) {
      if (byName.has(tool.name))
        throw new Error(`Host-managed MCP server "${server}" returned duplicate tool names`);
      byName.set(tool.name, tool);
    }
    const selected = definition.tools ? [...new Set(definition.tools)] : [...byName.keys()];
    return selected.map((name): CatalogTool => {
      const tool = byName.get(name);
      if (!tool)
        throw new Error(`Host-managed MCP server "${server}" does not list tool "${name}"`);
      const frozen = deepFreeze(structuredClone(tool));
      const { outputSchema, ...withoutOutputSchema } = frozen;
      let validateOutput: JsonSchemaValidator<unknown> | undefined;
      if (outputSchema) {
        try {
          validateOutput = validators.getValidator(structuredClone(outputSchema) as JsonSchemaType);
        } catch (cause) {
          throw new Error(
            `Host-managed MCP tool "${name}" on server "${server}" has an invalid outputSchema`,
            { cause },
          );
        }
      }
      return {
        server,
        toolName: formatToolName(name, server, "server"),
        definition: frozen,
        fingerprint: stableStringify(frozen),
        // The SDK reports its own output-schema failures as ProtocolError,
        // indistinguishable from a server error response; validate here instead.
        sdkDefinition: Object.freeze(withoutOutputSchema),
        validateOutput,
      };
    });
  }

  async function runConnect(
    server: string,
    definition: HostManagedMcpServer,
    validators: ReturnType<typeof createJsonSchemaValidator>,
  ): Promise<void> {
    // Synchronous bookkeeping before the first await, so a close() that starts
    // later sees this attempt and its factory in the tracking sets.
    if (closed) throw new HostManagedMcpError("not_sent", server);
    const tracked = trackFactory(server, definition.createTransport);
    let transport: Transport | undefined;
    let adopted = false;
    let connection: Connection | undefined;
    try {
      try {
        transport = await abortable(tracked.source, lifetime.signal);
        tracked.markAdopted();
        adopted = true;
      } catch (cause) {
        // Nothing adopted: the tracker closes a transport the factory may have
        // delivered after the abort, or owns nothing when the factory failed.
        tracked.release();
        throw cause;
      }
      const client = new Client(
        { name: `pibot-connector-${server}`, version: "1.0.0" },
        // No client capabilities, and no multi-round-trip auto-fulfilment: that
        // driver would resend the original tools/call with collected input.
        {
          capabilities: {},
          jsonSchemaValidator: validators,
          inputRequired: { autoFulfill: false },
        },
      );
      // Raw transport errors can carry credentials; the adapter never logs them.
      client.onerror = () => {};
      const created: Connection = {
        id: randomUUID(),
        client,
        transport,
        open: true,
        selected: undefined,
        refresh: undefined,
        refreshRequested: false,
        validators,
      };
      connection = created;
      client.onclose = () => {
        created.open = false;
      };
      // Registered directly rather than through ClientOptions.listChanged so
      // the change is known synchronously (no debounce) even when the server
      // does not advertise tools.listChanged.
      client.setNotificationHandler("notifications/tools/list_changed", () =>
        requestCatalogRefresh(created, definition, server),
      );
      if (closed) throw new HostManagedMcpError("not_sent", server);
      connections.set(server, created);
      const openOptions = {
        ...requestOptions(lifetime.signal),
        ...(options.openTimeoutMs ? { timeout: options.openTimeoutMs } : {}),
      };
      await client.connect(transport, openOptions);
      if (closed) throw new HostManagedMcpError("not_sent", server);
      const listed = (await client.listTools(undefined, openOptions)).tools;
      if (closed) throw new HostManagedMcpError("not_sent", server);
      const tools = buildCatalogTools(server, definition, listed, validators);
      created.selected = tools;
      // A notification that arrived before selection still gets its re-list.
      if (created.refreshRequested) requestCatalogRefresh(created, definition, server);
    } catch (cause) {
      if (connection) connections.delete(server);
      if (adopted && transport) {
        // This attempt adopted the transport, so it owns closing it — including
        // when close() is already running: close() sweeps connections only
        // after every connect attempt has settled its own resources.
        try {
          await closeTransport(transport);
        } catch {
          failedCloses.push(transport);
        }
      }
      throw new Error(`Host-managed MCP server "${server}" failed to start`, { cause });
    }
  }

  async function start(): Promise<void> {
    try {
      const validators = createJsonSchemaValidator();
      const attempts = servers.map(([server, definition]) => {
        const attempt = runConnect(server, definition, validators);
        activeConnects.add(attempt);
        // Rejections are collected by Promise.all below; the finally wrapper
        // must not surface the same rejection as an unhandled one.
        void attempt.catch(() => {});
        void attempt.finally(() => activeConnects.delete(attempt)).catch(() => {});
        return attempt;
      });
      await Promise.all(attempts);
      const published = publishCatalog();
      if (!published.ok) {
        throw new Error(
          `Host-managed MCP tools "${published.owner.server}/${published.owner.definition.name}" and "${published.duplicate.server}/${published.duplicate.definition.name}" both map to Pi Bot tool "${published.owner.toolName}"`,
        );
      }
      if (closed) throw new Error("Host-managed MCP adapter closed before it was ready");
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function executeTool(
    server: string,
    toolName: string,
    toolCallId: string,
    params: unknown,
    callerSignal: AbortSignal | undefined,
    extraMeta?: Readonly<Record<string, string>>,
  ): Promise<ToolResult> {
    const tool = catalog.find(
      (candidate) => candidate.toolName === toolName && candidate.server === server,
    );
    if (!tool) {
      return textResult(
        `MCP tool "${toolName}" on server "${server}" is not in the current catalog.`,
        { error: "unknown_tool", server, tool: toolName },
      );
    }
    const connection = connections.get(tool.server);
    if (closed || !connection?.open)
      return dispatchFailureResult(tool, new HostManagedMcpError("not_sent", tool.server));
    const name = tool.definition.name;

    let args: Readonly<Record<string, unknown>>;
    try {
      args = deepFreeze(normalizeToolArguments(params));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), {
        error: "invalid_arguments",
        server: tool.server,
        tool: name,
      });
    }

    const signal = combineAbortSignals(lifetime.signal, callerSignal) ?? lifetime.signal;
    if (closed || !connection.open || signal.aborted)
      return dispatchFailureResult(tool, new HostManagedMcpError("not_sent", tool.server));

    let dispatched = false;
    let sent = false;
    let settled = false;
    const unavailable = () => settled || closed || !connection.open || signal.aborted;
    const send = async (): Promise<CallToolResult> => {
      if (unavailable()) throw new HostManagedMcpError("not_sent", tool.server);
      sent = true;
      let result: CallToolResult;
      try {
        const meta = withToolCallIdMeta(extraMeta ? { ...extraMeta } : undefined, toolCallId);
        result = await connection.client.callTool(
          { name, arguments: args as Record<string, unknown>, ...(meta ? { _meta: meta } : {}) },
          { ...requestOptions(signal), toolDefinition: tool.sdkDefinition },
        );
      } catch (cause) {
        throw classifyDispatchError(tool.server, cause);
      }
      if (tool.validateOutput && !result.isError) {
        let valid = false;
        try {
          valid =
            result.structuredContent !== undefined &&
            tool.validateOutput(result.structuredContent).valid;
        } catch {
          valid = false;
        }
        if (!valid) throw new HostManagedMcpError("invalid_result", tool.server);
      }
      return result;
    };
    const call: HostManagedMcpToolCall = Object.freeze({
      server: tool.server,
      tool: name,
      toolName: tool.toolName,
      toolCallId,
      connectionId: connection.id,
      arguments: args,
      inputSchema: tool.definition.inputSchema,
      signal,
      dispatch() {
        if (dispatched)
          throw new Error(`dispatch() was already called for MCP tool call "${toolCallId}"`);
        dispatched = true;
        return send();
      },
    });

    let result: CallToolResult;
    try {
      result = await options.onToolCall(call);
    } catch (_error) {
      const details = { error: "host_error", server: tool.server, tool: name, sent };
      return sent
        ? textResult(
            `The host failed while handling MCP tool "${name}" on server "${tool.server}" after the request was sent, so it may have run. Do not retry automatically; check its effects first.`,
            details,
          )
        : textResult(
            `The host rejected MCP tool "${name}" on server "${tool.server}"; it was not run.`,
            details,
          );
    } finally {
      settled = true;
    }

    const content = resolveMcpResultContent(result as unknown as Record<string, unknown>);
    const outputContent =
      content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
    if (result.isError) {
      const guarded = await guardMcpOutput(outputContent, {
        ...guardOptions,
        prefix: "Error: ",
        emptyTextFallback: "Tool execution failed",
      });
      return {
        content: guarded.content,
        details: { error: "tool_error", server: tool.server, ...guardedMcpDetails(guarded) },
      };
    }
    const guarded = await guardMcpOutput(outputContent, guardOptions);
    return {
      content: guarded.content,
      details: { server: tool.server, tool: name, ...guardedMcpDetails(guarded) },
    };
  }

  function track(execution: Promise<ToolResult>): Promise<ToolResult> {
    inFlight.add(execution);
    void execution.finally(() => inFlight.delete(execution)).catch(() => {});
    return execution;
  }

  async function shutdown(): Promise<void> {
    closed = true;
    lifetime.abort();
    // Release every pending factory decision so trackers can finish owning
    // any transport a factory delivers after this point.
    for (const tracked of pendingFactories) tracked.release();
    // The Pi Bot pool owns the drain deadline; await the real in-flight set
    // instead of upstream's 5-second race so a result is never silently dropped.
    await Promise.allSettled([...inFlight]);
    // A transport factory that has not settled yet keeps close() waiting: close
    // cannot claim drained while a transport may still appear. Late deliveries
    // are closed by their tracker before the connection sweep below.
    await Promise.allSettled([...pendingFactories].map((tracked) => tracked.task));
    await Promise.allSettled([...activeConnects]);
    // Every attempt has settled its own resources; now close what remains.
    const transports = [
      ...[...connections.values()].map((connection) => {
        connection.open = false;
        return connection.transport;
      }),
      ...failedCloses,
    ];
    connections.clear();
    failedCloses = [];
    const failures: Transport[] = [];
    await Promise.allSettled(
      transports.map((transport) =>
        closeTransport(transport).catch(() => failures.push(transport)),
      ),
    );
    failedCloses = failures;
    catalog = [];
    // A fixed message only; the raw close error can carry credentials.
    if (failures.length > 0)
      throw new Error("Host-managed MCP adapter close failed; some transports did not close");
  }

  function close(): Promise<void> {
    // A failed close clears the cache so a retry sweeps what it still owns.
    closePromise ??= shutdown().catch((error) => {
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  }

  return {
    ready() {
      readyPromise ??= closed
        ? Promise.reject(new Error("Host-managed MCP adapter is closed"))
        : start();
      return readyPromise;
    },
    close,
    catalog() {
      return catalog;
    },
    callTool(
      server: string,
      toolName: string,
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      meta?: Readonly<Record<string, string>>,
    ) {
      return track(executeTool(server, toolName, toolCallId, params, signal, meta));
    },
  };
}

interface Connection {
  readonly id: string;
  readonly client: Client;
  readonly transport: Transport;
  readonly validators: ReturnType<typeof createJsonSchemaValidator>;
  open: boolean;
  selected: readonly CatalogTool[] | undefined;
  refresh: Promise<void> | undefined;
  refreshRequested: boolean;
}
