import { randomUUID } from "node:crypto";
import { Methods, RpcErrorCodes } from "@pibot/protocol";
import {
  GUI_RPC_CAPACITY,
  GUI_RPC_QUEUE_LIMIT,
  GuiRpcDispatchSchema,
  type GuiRpcRequest,
  GuiRpcRequestSchema,
  guiRpcReservation,
} from "../../shared/gui-rpc.ts";
import { MAX_FRAME } from "../background/background-wire.ts";

const capacity = GUI_RPC_CAPACITY;
const reserved = 2;
const queueLimit = GUI_RPC_QUEUE_LIMIT;
const reservedBytes = 64 * 1024;
interface Entry {
  route: string;
  document?: string;
  id: GuiRpcRequest["id"];
  bytes: number;
}
interface Waiting extends Entry {
  message: GuiRpcRequest;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  urgent: boolean;
}

/** Connection-owned slots outlive a renderer's local promise and document. */
export function createGuiRequestQueue(options: {
  send(message: GuiRpcRequest): void;
  reply(document: string, message: unknown): void;
  failed(): void;
}) {
  const active = new Map<string, Entry>();
  const waiting: Waiting[] = [];
  let bytes = 0;
  let activeBytes = 0;
  let failed = false;
  const error = (entry: Entry, code: number, message: string) => {
    if (entry.document)
      options.reply(entry.document, { jsonrpc: "2.0", id: entry.id, error: { code, message } });
  };
  const remove = (index: number) => {
    const [entry] = waiting.splice(index, 1);
    if (!entry) throw new Error("Missing queued RPC");
    clearTimeout(entry.timer);
    bytes -= entry.bytes;
    return entry;
  };
  const clear = () => {
    while (waiting.length) error(remove(0), RpcErrorCodes.closed, "GUI transport closed");
    for (const entry of active.values()) error(entry, RpcErrorCodes.closed, "GUI transport closed");
    active.clear();
    activeBytes = 0;
  };
  const pump = () => {
    while (!failed && active.size < capacity) {
      let index = waiting.findIndex((entry) => entry.message.method === "chat.abort");
      if (index < 0 && active.size < capacity - 1)
        index = waiting.findIndex((entry) => entry.urgent);
      if (index < 0) {
        if (active.size >= capacity - reserved) return;
        index = waiting.length ? 0 : -1;
      }
      if (index < 0) return;
      const next = waiting[index];
      if (!next) return;
      const byteReservation = guiRpcReservation(next.message.method) * (reservedBytes / reserved);
      if (activeBytes + next.bytes > MAX_FRAME - byteReservation) return;
      const entry = remove(index);
      if (entry.deadline <= Date.now()) {
        error(entry, RpcErrorCodes.timeout, "RPC timed out");
        continue;
      }
      // Do not retain payloads in active slots; the owner already owns the accepted request.
      active.set(entry.route, {
        route: entry.route,
        document: entry.document,
        id: entry.id,
        bytes: entry.bytes,
      });
      activeBytes += entry.bytes;
      try {
        options.send({ ...entry.message, id: entry.route });
      } catch {
        failed = true;
        clear();
        options.failed();
      }
    }
  };
  const cancel = (document: string, id?: GuiRpcRequest["id"]) => {
    for (let index = waiting.length - 1; index >= 0; index--) {
      const entry = waiting[index];
      if (entry?.document === document && (id === undefined || entry.id === id)) {
        error(remove(index), RpcErrorCodes.closed, "GUI request cancelled");
      }
    }
    for (const entry of active.values()) {
      if (entry.document === document && (id === undefined || entry.id === id))
        entry.document = undefined;
    }
    pump();
  };
  return {
    receive(document: string, value: unknown) {
      const envelope = GuiRpcDispatchSchema.safeParse(value);
      if (envelope.success && envelope.data.kind !== "request") {
        cancel(document, envelope.data.kind === "cancel" ? envelope.data.id : undefined);
        return;
      }
      const request = GuiRpcRequestSchema.safeParse(
        envelope.success && envelope.data.kind === "request" ? envelope.data.message : value,
      );
      if (!request.success) return;
      const entry: Entry = { route: randomUUID(), document, id: request.data.id, bytes: 0 };
      const method = request.data.method;
      if (!Object.hasOwn(Methods, method)) {
        error(entry, RpcErrorCodes.methodNotFound, "Method not found");
        return;
      }
      if (!Methods[method as keyof typeof Methods].params.safeParse(request.data.params).success) {
        error(entry, RpcErrorCodes.invalidParams, "Schema validation failed");
        return;
      }
      if (failed) {
        error(entry, RpcErrorCodes.closed, "GUI transport closed");
        return;
      }
      const reservation = guiRpcReservation(method);
      const urgent = reservation < reserved;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify({ ...request.data, id: entry.route }));
      } catch {
        error(entry, RpcErrorCodes.invalidRequest, "Invalid request");
        return;
      }
      if (
        waiting.length >= queueLimit - reservation ||
        bytes + size > MAX_FRAME - reservation * (reservedBytes / reserved)
      ) {
        error(entry, RpcErrorCodes.busy, "GUI request queue full");
        return;
      }
      const deadline =
        envelope.success && envelope.data.kind === "request"
          ? envelope.data.deadline
          : Date.now() + 30_000;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || remaining > 2_147_483_647) {
        error(entry, RpcErrorCodes.timeout, "RPC timed out");
        return;
      }
      if (
        waiting.some((v) => v.document === document && v.id === entry.id) ||
        [...active.values()].some((v) => v.document === document && v.id === entry.id)
      ) {
        error(entry, RpcErrorCodes.invalidRequest, "Duplicate RPC id");
        return;
      }
      waiting.push({
        ...entry,
        message: request.data,
        bytes: size,
        deadline,
        urgent,
        timer: setTimeout(() => {
          const index = waiting.findIndex((v) => v.route === entry.route);
          if (index >= 0) error(remove(index), RpcErrorCodes.timeout, "RPC timed out");
          pump();
        }, remaining),
      });
      bytes += size;
      pump();
    },
    response(value: unknown) {
      if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
        return false;
      const entry = active.get(value.id);
      if (!entry) return false;
      active.delete(value.id);
      activeBytes -= entry.bytes;
      if (entry.document) options.reply(entry.document, { ...value, id: entry.id });
      pump();
      return true;
    },
    retire: (document: string) => cancel(document),
    disconnected() {
      clear();
      failed = false;
    },
    dispose() {
      failed = true;
      clear();
    },
  };
}
