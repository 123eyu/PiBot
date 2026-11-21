import { sha256Hex } from "@pibot/link";
import {
  createPeer,
  type Params,
  type Port,
  type Result,
  RunnerExecutionErrorSchema,
  type RunnerMethods,
  RunnerOutputChunkSchema,
  RunnerTransferDescriptorSchema,
  runnerEvents,
  runnerMethods,
} from "@pibot/protocol-base";
import { toBase64 } from "../storage/base64.ts";
import { fromBase64 } from "./jpeg.ts";

export interface RunnerWire {
  port: Port;
  signal: AbortSignal;
  close(): Promise<void>;
}
const encoder = new TextEncoder();
const MAX_BYTES = 1024 * 1024;

/** Narrow RN client: one generation, bounded transfers, no automatic execution retry. */
export class PhoneRunnerClient {
  private readonly peer;
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private readonly confirmations = new Map<string, () => void>();
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly wire: RunnerWire,
    owner: AbortSignal,
  ) {
    this.signal = AbortSignal.any([owner, wire.signal, this.lifetime.signal]);
    this.peer = createPeer(wire.port, {
      methods: runnerMethods,
      events: runnerEvents,
      errorDataSchema: RunnerExecutionErrorSchema,
    });
    this.peer.handle("runner.dispatch.confirm", async ({ opId }) => {
      const confirm = this.confirmations.get(opId);
      if (!confirm) throw new Error("approval_changed");
      confirm();
      return null;
    });
  }
  async initialize(capabilities: readonly string[], target: string, signal: AbortSignal) {
    const info = await this.call("runner.info", {}, signal);
    if (info.targetId !== target) throw new Error("runner_identity_mismatch");
    const manifest = await this.call("runner.capabilities.negotiate", {}, signal);
    const enabled = capabilities.filter((id) =>
      manifest.capabilities.some(
        (c) => c.id === id && c.version === 1 && c.availability === "available",
      ),
    );
    await this.call("runner.capabilities.set", { capabilities: [...enabled] }, signal);
    await this.call("runner.executionChecks.enable", {}, signal);
    return info;
  }
  call<M extends keyof RunnerMethods>(
    method: M,
    params: Params<RunnerMethods, M>,
    signal: AbortSignal,
    timeoutMs = 20_000,
    output?: (text: string) => void,
  ): Promise<Result<RunnerMethods, M>> {
    const active = AbortSignal.any([this.signal, signal]);
    active.throwIfAborted();
    const task = this.peer.call(method, params, {
      signal: active,
      timeoutMs,
      ...(output
        ? {
            streamSchema: RunnerOutputChunkSchema,
            onStream: (chunk: unknown) => output(RunnerOutputChunkSchema.parse(chunk).text),
          }
        : {}),
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  async approved<T>(id: string, confirm: () => void, work: () => Promise<T>) {
    if (this.confirmations.has(id)) throw new Error("approval_busy");
    this.confirmations.set(id, confirm);
    try {
      confirm();
      return await work();
    } finally {
      this.confirmations.delete(id);
    }
  }
  async pull(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const descriptor = RunnerTransferDescriptorSchema.parse(raw);
    if (descriptor.bytes > MAX_BYTES) throw new Error("runner_result_too_large");
    const body = new Uint8Array(descriptor.bytes);
    let offset = 0;
    try {
      for (let sequence = 0; sequence < 8; sequence++) {
        const part = await this.call(
          "runner.transfer.pull",
          { transferId: descriptor.transferId, sequence },
          signal,
        );
        const bytes = fromBase64(part.data);
        if (!bytes || bytes.length > 512 * 1024 || offset + bytes.length > body.length)
          throw new Error("runner_result_invalid");
        body.set(bytes, offset);
        offset += bytes.length;
        if (part.done) {
          if (offset !== body.length || sha256Hex(body) !== descriptor.sha256)
            throw new Error("runner_result_invalid");
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        }
      }
      throw new Error("runner_result_invalid");
    } finally {
      await this.cancel(descriptor.transferId);
    }
  }
  async file(
    request: unknown,
    signal: AbortSignal,
    write?: { dispatchOpId: string; idempotencyKey: string; issuedAt: string },
  ) {
    const body = encoder.encode(JSON.stringify(request));
    if (!body.length || body.length > MAX_BYTES) throw new Error("runner_file_too_large");
    const transferId = crypto.randomUUID();
    try {
      await this.call(
        "runner.transfer.begin",
        {
          transferId,
          bytes: body.length,
          sha256: sha256Hex(body),
          request: { kind: "file" },
          ...write,
        },
        signal,
      );
      for (let offset = 0, sequence = 0; offset < body.length; offset += 256 * 1024, sequence++) {
        await this.call(
          "runner.transfer.chunk",
          { transferId, sequence, data: toBase64(body.subarray(offset, offset + 256 * 1024)) },
          signal,
        );
      }
      return await this.pull(
        await this.call("runner.transfer.commit", { transferId }, signal),
        signal,
      );
    } finally {
      await this.cancel(transferId);
    }
  }
  private async cancel(transferId: string) {
    try {
      await this.call("runner.transfer.cancel", { transferId }, AbortSignal.timeout(2000), 2000);
    } catch {
      /* Session closure is the final cleanup owner when the link cannot answer. */
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.lifetime.abort();
      this.confirmations.clear();
      await Promise.allSettled([...this.pending]);
      this.peer.dispose();
      await this.wire.close();
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
