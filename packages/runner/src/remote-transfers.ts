import { createHash, randomUUID } from "node:crypto";
import { ExecError } from "@pibot/execution";
import { MAX_PLAINTEXT } from "@pibot/link";
import { RpcError, RpcErrorCodes, RunnerTransferDescriptorSchema } from "@pibot/protocol-base";
import type { BeginParams, IssuedKey, RemoteDeps, TransferChannel } from "./remote-state.ts";

const CHUNK_BYTES = 512 * 1024;
const TRANSFER_DEADLINE_MS = 55_000;
const MAX_ACTIVE_TRANSFERS = 4;
const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
if (Math.ceil((CHUNK_BYTES * 4) / 3) + 1024 > MAX_PLAINTEXT)
  throw new Error("Runner chunk exceeds encrypted frame limit");

/**
 * File bytes never ride the request itself: a transfer is reserved, pulled or pushed in chunks
 * under one deadline, and its capacity is bounded per link. The reservations live here so a
 * dropped link can release them in one place (`clear`).
 */
export function createTransferChannel(
  deps: Pick<RemoteDeps, "call" | "link" | "isDisconnected">,
): TransferChannel {
  const { call, link, isDisconnected } = deps;
  const transferReservations = new Map<string, number>();
  let aggregateTransferBytes = 0;

  function reserveTransfer(bytes: number) {
    if (isDisconnected() || link.aborted)
      throw new RpcError(RpcErrorCodes.closed, "Runner connection closed");
    if (
      transferReservations.size >= MAX_ACTIVE_TRANSFERS ||
      aggregateTransferBytes + bytes > MAX_AGGREGATE_BYTES
    )
      throw new RpcError(RpcErrorCodes.busy, "Runner transfer capacity exhausted");
    const reservationId = randomUUID();
    transferReservations.set(reservationId, bytes);
    aggregateTransferBytes += bytes;
    return () => {
      const reserved = transferReservations.get(reservationId);
      if (reserved === undefined) return;
      transferReservations.delete(reservationId);
      aggregateTransferBytes -= reserved;
    };
  }

  function clearTransferReservations() {
    transferReservations.clear();
    aggregateTransferBytes = 0;
  }

  async function cancelTransfer(transferId: string) {
    try {
      await call(
        "runner.transfer.cancel",
        { transferId },
        { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 },
      );
    } catch {
      // A closed link releases all transfers on the runner's Port close callback.
    }
  }
  async function pull(descriptor: Parameters<TransferChannel["pull"]>[0], signal: AbortSignal) {
    const parsed = RunnerTransferDescriptorSchema.parse({
      transferId: descriptor.transferId,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
    });
    const releaseReservation = reserveTransfer(parsed.bytes);
    const maximumChunks = Math.max(1, Math.ceil(parsed.bytes / CHUNK_BYTES));
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new RpcError(RpcErrorCodes.closed, "Runner transfer timed out")),
      TRANSFER_DEADLINE_MS,
    );
    const pullSignal = AbortSignal.any([signal, deadline.signal]);
    let offset = 0;
    let complete = false;
    try {
      const bytes = Buffer.alloc(parsed.bytes);
      for (let sequence = 0; sequence < maximumChunks; sequence++) {
        pullSignal.throwIfAborted();
        const part = await call(
          "runner.transfer.pull",
          { transferId: parsed.transferId, sequence },
          { signal: pullSignal },
        );
        const chunk = Buffer.from(part.data, "base64");
        if (chunk.length > CHUNK_BYTES || offset + chunk.length > bytes.length)
          throw new ExecError("file_failed");
        if (!part.done && chunk.length === 0)
          throw new RpcError(RpcErrorCodes.invalidRequest, "Runner transfer made no progress");
        chunk.copy(bytes, offset);
        offset += chunk.length;
        if (part.done) {
          complete = true;
          break;
        }
      }
      if (
        !complete ||
        offset !== bytes.length ||
        createHash("sha256").update(bytes).digest("hex") !== parsed.sha256
      )
        throw new ExecError("file_failed");
      return bytes;
    } finally {
      clearTimeout(deadlineTimer);
      if (!complete) await cancelTransfer(parsed.transferId);
      releaseReservation();
    }
  }
  async function upload(
    bytes: Uint8Array,
    request: BeginParams["request"],
    signal: AbortSignal,
    key?: IssuedKey,
    dispatchOpId?: string,
  ) {
    const transferId = randomUUID();
    const releaseReservation = reserveTransfer(bytes.byteLength);
    let begun = false;
    try {
      const body = Buffer.from(bytes);
      const sha256 = createHash("sha256").update(body).digest("hex");
      await call(
        "runner.transfer.begin",
        {
          transferId,
          bytes: body.length,
          sha256,
          request,
          ...(key ?? {}),
          ...(dispatchOpId ? { dispatchOpId } : {}),
        },
        { signal },
      );
      begun = true;
      for (let offset = 0, sequence = 0; offset < body.length; offset += CHUNK_BYTES, sequence++) {
        signal.throwIfAborted();
        await call(
          "runner.transfer.chunk",
          {
            transferId,
            sequence,
            data: body.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
          },
          { signal },
        );
      }
      return await call("runner.transfer.commit", { transferId }, { signal });
    } catch (error) {
      if (begun) await cancelTransfer(transferId);
      throw error;
    } finally {
      releaseReservation();
    }
  }
  async function pullJson<T>(
    descriptor: Parameters<TransferChannel["pullJson"]>[0],
    signal: AbortSignal,
    parse: (value: unknown) => T,
  ) {
    return parse(JSON.parse((await pull(descriptor, signal)).toString("utf8")));
  }
  return {
    pull,
    upload,
    pullJson,
    cancel: cancelTransfer,
    clear: clearTransferReservations,
  };
}
