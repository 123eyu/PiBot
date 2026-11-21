import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  type AcpDebugEvent,
  createAcpAgent,
  createAcpFolderStaging,
  createAcpNdJsonStream,
  createAcpSessionMemory,
} from "@pibot/acp";
import {
  ACP_MAX_CONNECTIONS,
  ACP_MAX_FRAME,
  type AcpAttachmentPort,
  AcpChannelSchema,
  type AcpClient,
  type AcpLifecycleEvent,
  type AcpState,
  type createPeer,
  type Events,
  type Methods,
  type Port,
  RpcError,
} from "@pibot/protocol";
import { createDesktopAcpRuntime, releaseAcpResponseReservations } from "./acp-runtime.ts";

/** Ids and folder paths only; owner-only, replaced atomically so a crash never leaves half a file. */
function sessionFilePersistence(file: string) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch {
        // Missing or unreadable: start empty; clients fall back to new sessions.
        return undefined;
      }
    },
    save(value: unknown) {
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
        renameSync(temp, file);
      } catch {
        // Persistence is a convenience: in-memory records still serve this app run.
        rmSync(temp, { force: true });
      }
    },
  };
}

/**
 * Fixed tokens only: a connection error can embed a path or a message body, and the caller logs
 * this string (prompts, keys and file content stay out of logs).
 */
function failureReason(error: unknown): string {
  const identifier = (text: string) => /^[a-z][a-z0-9_]{0,63}$/.test(text);
  if (error instanceof RpcError) return `rpc_${error.code}`;
  if (error instanceof Error) return identifier(error.message) ? error.message : error.name;
  return typeof error;
}

/** One SDK writer per connection (up to 4). Every output waits for its drain receipt. */
export function createDesktopAcp(
  channel: Port,
  version: string,
  /**
   * Connection-scoped cleanup failures. A single broken client must never reach the process:
   * stopping the brain cancels every other topic's run of the same Bot (four runs were lost once).
   */
  warn: (failures: string[]) => void,
  debug?: (event: AcpDebugEvent) => void,
  /** File for ACP session records, so session/load also works after an app restart. */
  sessionFile?: string,
) {
  const folders = createAcpFolderStaging();
  // Across ACP connections and (with a file) app restarts: lets a client session/load its own
  // ACP-created session and keep working in the same topic (self-iteration steps).
  const sessionMemory = createAcpSessionMemory(
    sessionFile ? { persistence: sessionFilePersistence(sessionFile) } : {},
  );
  const observers = new Set<(event: AcpLifecycleEvent) => void>();
  const emit = (event: AcpLifecycleEvent) => {
    for (const observer of observers) observer(event);
  };
  type Connection = {
    id: string;
    client: AcpClient;
    closing?: Promise<void>;
    translator: ReturnType<typeof createAcpAgent>;
    sdk: { close(): void; closed: Promise<void> };
    writer: WritableStreamDefaultWriter<Uint8Array>;
    peer: ReturnType<typeof createPeer<typeof Methods, typeof Events>>;
    output: Map<
      string,
      { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    >;
    input: Promise<void>;
    bytes: number;
    pending: number;
    inflight: Map<string, number>;
    requestBytes: number;
    runs: Set<string>;
    lifetime: AbortController;
    work: Set<Promise<unknown>>;
    uncertain(): boolean;
  };
  const active = new Map<string, Connection>();
  /** The status line names the most recent client; the GUI's disconnect ends every connection. */
  const latest = () => [...active.values()].filter((connection) => !connection.closing).at(-1);
  const requests = new Set<(message: unknown) => void>();
  const responses = new Set<(message: unknown) => void>();
  // Only the in-process runtime Peer writes this namespace; opaque ACP frames never do.
  const business: Port = {
    post: (message) => {
      for (const listener of responses) listener(message);
    },
    onMessage: (listener) => {
      requests.add(listener);
      return () => {
        requests.delete(listener);
      };
    },
  };
  const loopback: Port = {
    post: (message) => {
      for (const listener of requests) listener(message);
    },
    onMessage: (listener) => {
      responses.add(listener);
      return () => {
        responses.delete(listener);
      };
    },
  };
  /**
   * Tears one connection down even when a step fails. A half-closed connection keeps holding
   * output reservations and lets a later disconnect repeat the same failure, so every step is
   * attempted and the failures are reported once, at the end.
   */
  const closeConnection = async (current: Connection) => {
    const failures: string[] = [];
    const attempt = async (step: string, action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        failures.push(`${step}:${failureReason(error)}`);
      }
    };
    current.lifetime.abort();
    await attempt("translator", () => current.translator.dispose());
    await attempt("work", () => Promise.allSettled([...current.work]));
    // A dispatched mutation that never settled may still land; it is reported beside the rest.
    if (current.uncertain()) failures.push("dispatch_unconfirmed");
    // Ask for every run's stop even if one is refused: one stuck run must not leave the other
    // runs of this connection unflagged (and a run that already ended answers ok by design).
    for (const runId of current.runs)
      await attempt("abort", () =>
        current.peer.call("chat.abort", { runId }, { timeoutMs: 30_000 }),
      );
    current.runs.clear();
    await attempt("input", () =>
      current.input.catch(() => {
        // Input failure triggers disconnect too; it cannot veto transport cleanup once runs drained.
      }),
    );
    // Translator abort waits on the existing chat.abort drain, with its original policy/locks.
    emit({ kind: "acp.detach", client: current.client });
    current.sdk.close();
    await attempt("writer", () =>
      current.writer.abort().catch(() => {
        /* SDK may have already closed its reader. */
      }),
    );
    for (const wait of current.output.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error("app_quit"));
    }
    current.output.clear();
    current.peer.dispose();
    if (active.get(current.id) === current) active.delete(current.id);
    channel.post({ type: "closed", connection: current.id });
    if (!failures.length) return;
    warn(failures);
    throw new Error("acp_connection_cleanup_failed");
  };
  const disconnect = async (connection?: string) => {
    if (!connection) {
      const results = await Promise.allSettled([...active.keys()].map((id) => disconnect(id)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw (failure as PromiseRejectedResult).reason;
      return;
    }
    const current = active.get(connection);
    if (!current) return;
    current.closing ??= closeConnection(current);
    await current.closing;
  };
  const host: AcpAttachmentPort = {
    state: (): AcpState => {
      const current = latest();
      return current ? { connected: true, client: current.client } : { connected: false };
    },
    disconnect: async (signal) => {
      signal.throwIfAborted();
      await disconnect();
    },
    subscribe: (listener) => {
      observers.add(listener);
      return () => {
        observers.delete(listener);
      };
    },
  };
  const refused = (connection?: string) => {
    // The connection is already closed and its failures already reported by closeConnection;
    // nothing here may reach the process, which serves every other topic of this Bot too.
    void disconnect(connection).catch(() => {});
  };
  const off = channel.onMessage((raw) => {
    const parsed = AcpChannelSchema.safeParse(raw);
    if (!parsed.success) {
      refused();
      return;
    }
    const message = parsed.data;
    if (message.type === "attach") {
      if (active.size >= ACP_MAX_CONNECTIONS || active.has(message.connection) || !observers.size) {
        channel.post({ type: "reply", id: message.id, ok: false });
        return;
      }
      try {
        const owned = createDesktopAcpRuntime(loopback, folders, emit);
        const { peer, runtime, lifetime, work, runs } = owned;
        const input = new TransformStream<Uint8Array, Uint8Array>(
          undefined,
          { highWaterMark: 1 },
          { highWaterMark: 1 },
        );
        const writer = input.writable.getWriter();
        const output = new Map<
          string,
          { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
        >();
        const stream = createAcpNdJsonStream(
          new WritableStream<Uint8Array>({
            write: (bytes) => {
              if (bytes.byteLength > ACP_MAX_FRAME) throw new Error("acp_frame_too_large");
              const id = randomUUID();
              const frame: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
              const owner = active.get(message.connection);
              if (owner) releaseAcpResponseReservations(owner, frame);
              return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  output.delete(id);
                  reject(new Error("acp_output_timeout"));
                  refused(message.connection);
                }, 15_000);
                output.set(id, { resolve, reject, timer });
                channel.post({ type: "frame", connection: message.connection, id, message: frame });
              });
            },
          }),
          input.readable,
          { maxMessageBytes: ACP_MAX_FRAME },
        );
        const translator = createAcpAgent({
          runtime,
          version,
          debug,
          maxSessions: 64,
          permissionBudget: { requests: 16, bytes: 1024 * 1024 },
          onPermissionCapacity: () => refused(message.connection),
          outputBudget: { events: 256, bytes: ACP_MAX_FRAME },
          sessionMemory,
        });
        const sdk = translator.app.connect(stream);
        active.set(message.connection, {
          id: message.connection,
          client: message.client,
          translator,
          sdk,
          writer,
          peer,
          output,
          input: Promise.resolve(),
          bytes: 0,
          pending: 0,
          inflight: new Map(),
          requestBytes: 0,
          runs,
          lifetime,
          work,
          uncertain: owned.uncertain,
        });
        emit({ kind: "acp.attach", client: message.client });
        void sdk.closed
          .then(() => disconnect(message.connection))
          // A failed teardown is reported by closeConnection and closes this connection only.
          .catch(() => {});
        channel.post({ type: "reply", id: message.id, ok: true });
      } catch {
        // A client that cannot be set up is closed; the brain and other connections stay up.
        warn(["attach_failed"]);
        void disconnect(message.connection).catch(() => {});
        channel.post({ type: "reply", id: message.id, ok: false });
      }
    } else if (message.type === "detach") {
      // Already disposed (an earlier detach finished after the owner's wait expired): no run can
      // belong to it any more, so confirm. Silence here kept the owner's slot held forever.
      if (!active.has(message.connection)) {
        channel.post({ type: "reply", id: message.id, ok: true });
        return;
      }
      void disconnect(message.connection)
        .then(() => channel.post({ type: "reply", id: message.id, ok: true }))
        .catch(() => {
          // The connection is gone either way; the client is told so it can stop expecting output.
          channel.post({ type: "reply", id: message.id, ok: false });
        });
    } else if (message.type === "ack") {
      const current = active.get(message.connection);
      if (!current) return;
      const wait = current.output.get(message.id);
      if (wait) {
        current.output.delete(message.id);
        clearTimeout(wait.timer);
        wait.resolve();
      }
    } else if (message.type === "frame") {
      const current = active.get(message.connection);
      if (!current || current.closing) return;
      const bytes = Buffer.from(`${JSON.stringify(message.message)}\n`);
      if (
        bytes.byteLength > ACP_MAX_FRAME ||
        current.bytes + bytes.length > ACP_MAX_FRAME ||
        current.pending >= 16
      ) {
        refused(message.connection);
        return;
      }
      const frames = Array.isArray(message.message) ? message.message : [message.message];
      if (frames.length > 16) {
        refused(message.connection);
        return;
      }
      for (const frame of frames) {
        if (!frame || typeof frame !== "object" || !("method" in frame) || !("id" in frame))
          continue;
        const key = JSON.stringify(frame.id);
        if (
          current.inflight.has(key) ||
          current.inflight.size >= 16 ||
          current.requestBytes + bytes.length > ACP_MAX_FRAME
        ) {
          refused(message.connection);
          return;
        }
        current.inflight.set(key, bytes.length);
        current.requestBytes += bytes.length;
      }
      current.bytes += bytes.length;
      current.pending++;
      const write = current.input
        .then(async () => {
          await current.writer.write(bytes);
          channel.post({ type: "ack", connection: current.id, id: message.id });
        })
        .finally(() => {
          current.bytes -= bytes.length;
          current.pending--;
        });
      current.input = write;
      void write.catch(() => refused(current.id));
    }
  });
  return {
    business,
    host,
    folders,
    async dispose() {
      await disconnect();
      off();
      observers.clear();
      requests.clear();
      responses.clear();
    },
  };
}
