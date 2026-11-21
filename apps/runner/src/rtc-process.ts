import { type ChildProcess, fork } from "node:child_process";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import {
  type DataChannelEvent,
  type DataChannelLike,
  type RtcPeerFactory,
  RtcStateSchema,
} from "@pibot/link";
import type { RtcRequest } from "./rtc-child.ts";

const CLOSE_MS = 2_000;
const MAX_BUFFER = 4 * 1024 * 1024;
type Request = RtcRequest extends infer T ? (T extends RtcRequest ? Omit<T, "id"> : never) : never;

export function forkRtcChild() {
  const sea = isSea();
  return fork(
    sea ? "--pibot-internal" : fileURLToPath(new URL("./rtc-child-entry.ts", import.meta.url)),
    sea ? ["rtc"] : [],
    {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      ...(sea ? { execArgv: [] } : {}),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(systemroot|windir)$/i.test(key)),
      ),
    },
  );
}

export function createProcessRtcFactory(
  warn: (code: string) => void = () => {},
  launch = forkRtcChild,
) {
  const peers = new Set<ProcessPeer>();
  let disposed = false;
  const createPeer: RtcPeerFactory = async (options) => {
    options.signal.throwIfAborted();
    if (disposed || peers.size >= 8) throw new Error("runner_rtc_unavailable");
    const peer = new ProcessPeer(launch(), options, warn);
    peers.add(peer);
    void peer.exited.then(() => peers.delete(peer));
    try {
      await peer.call(
        {
          op: "init",
          options: { role: options.role, stunUrl: options.stunUrl },
        },
        AbortSignal.timeout(5_000),
      );
      return peer;
    } catch {
      peer.close();
      throw new Error("runner_rtc_unavailable");
    }
  };
  return {
    createPeer,
    async close() {
      disposed = true;
      await Promise.all([...peers].map((peer) => peer.close()));
    },
  };
}

class ProcessChannel implements DataChannelLike {
  binaryType = "arraybuffer";
  readyState: DataChannelLike["readyState"] = "connecting";
  queued = 0;
  nativeBuffered = 0;
  private threshold = 0;
  private listeners = new Map<string, Set<(event: DataChannelEvent) => void>>();
  constructor(private readonly peer: ProcessPeer) {}
  get bufferedAmount() {
    return this.queued + this.nativeBuffered;
  }
  get bufferedAmountLowThreshold() {
    return this.threshold;
  }
  set bufferedAmountLowThreshold(value: number) {
    this.threshold = value;
    void this.peer.call({ op: "threshold", value }).catch(() => this.close());
  }
  send(data: ArrayBuffer) {
    if (
      this.readyState !== "open" ||
      data.byteLength > 64 * 1024 ||
      this.bufferedAmount + data.byteLength > MAX_BUFFER
    )
      throw new Error("runner_rtc_send_failed");
    this.queued += data.byteLength;
    void this.peer.call<number>({ op: "send", data: Buffer.from(data) }).then(
      (buffered) => {
        this.queued -= data.byteLength;
        this.nativeBuffered = buffered;
        if (this.bufferedAmount <= this.threshold) this.emit({ type: "bufferedamountlow" });
      },
      () => this.close(),
    );
  }
  close() {
    void this.peer.close();
  }
  addEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(event: DataChannelEvent) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }
  end() {
    this.readyState = "closed";
    try {
      this.emit({ type: "close" });
    } finally {
      this.listeners.clear();
    }
  }
}

class ProcessPeer {
  private readonly channel = new ProcessChannel(this);
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly candidates = new Set<(value: string) => void>();
  private readonly lifetime = new AbortController();
  private next = 0;
  private closing?: Promise<void>;
  private timedOut = false;
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: Parameters<RtcPeerFactory>[0],
    private readonly warn: (code: string) => void,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", (code) => {
        if (!this.closing || code !== 0) {
          if (!this.closing) warn("rtc_child_exited");
          else if (!this.timedOut && code !== null) warn("rtc_close_failed");
        }
        resolve();
      });
    });
    void this.exited.then(this.abort);
    child.on("error", this.abort);
    child.on("disconnect", this.abort);
    child.on("message", this.receive);
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }
  private abort = () => {
    void this.close();
  };
  private receive = (raw: unknown) => {
    if (this.closing || !raw || typeof raw !== "object") return;
    const msg = raw as {
      id?: number;
      value?: unknown;
      failed?: boolean;
      candidate?: string;
      diagnostic?: unknown;
      event?: DataChannelEvent;
      buffered?: number;
    };
    if (msg.id !== undefined) {
      const request = this.pending.get(msg.id);
      if (msg.failed) request?.reject(new Error("runner_rtc_request_failed"));
      else request?.resolve(msg.value);
    }
    if (typeof msg.candidate === "string")
      for (const listener of this.candidates) listener(msg.candidate);
    const diagnostic = RtcStateSchema.safeParse(msg.diagnostic);
    if (diagnostic.success) {
      this.options.onDiagnostic?.(diagnostic.data);
      if (["failed", "disconnected", "closed"].includes(diagnostic.data.state)) this.abort();
    }
    if (this.closing || !msg.event) return;
    const { event } = msg;
    if (event.type === "close" || event.type === "error") return this.abort();
    if (event.type === "open") this.channel.readyState = "open";
    if (typeof msg.buffered === "number") this.channel.nativeBuffered = msg.buffered;
    if (event.type !== "message" || (Buffer.isBuffer(event.data) && event.data.length <= 64 * 1024))
      this.channel.emit(event);
  };
  async call<T = void>(request: Request, signal?: AbortSignal): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.pending.size >= 1024) throw new Error("runner_rtc_queue_full");
    const id = ++this.next;
    const cancel = () => this.pending.get(id)?.reject(new Error("runner_rtc_closed"));
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
        signal?.addEventListener("abort", cancel, { once: true });
        this.child.send({ ...request, id }, (error) => {
          if (error) cancel();
        });
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(id);
    }
  }
  createDataChannel() {
    void this.call({ op: "channel" }).catch(this.abort);
    return this.channel;
  }
  async waitDataChannel() {
    this.lifetime.signal.throwIfAborted();
    if (this.channel.readyState === "open") return this.channel;
    return new Promise<DataChannelLike>((resolve, reject) => {
      const open = () => {
        this.channel.removeEventListener("close", closed);
        this.channel.removeEventListener("open", open);
        resolve(this.channel);
      };
      const closed = () => reject(new Error("runner_rtc_closed"));
      this.channel.addEventListener("open", open);
      this.channel.addEventListener("close", closed);
    });
  }
  createOffer() {
    return this.call<string>({ op: "offer" });
  }
  acceptOffer(value: string) {
    return this.call<string>({ op: "answer", value });
  }
  acceptAnswer(value: string) {
    return this.call({ op: "accept", value });
  }
  addCandidate(value: string) {
    return this.call({ op: "candidate", value });
  }
  onCandidate(listener: (value: string) => void) {
    this.candidates.add(listener);
    return () => {
      this.candidates.delete(listener);
    };
  }
  close() {
    if (this.closing) return this.closing;
    // Set the owner before emitting close: link listeners may re-enter close synchronously.
    this.closing = this.stopChild();
    this.options.signal.removeEventListener("abort", this.abort);
    const error = new Error("runner_rtc_closed");
    this.lifetime.abort(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.candidates.clear();
    this.channel.end();
    return this.closing;
  }
  private async stopChild() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.timedOut = true;
        this.warn("rtc_close_timeout");
        if (!this.child.kill("SIGKILL")) {
          this.warn("rtc_terminate_failed");
          this.child.channel?.unref();
          this.child.unref();
        }
        resolve();
      }, CLOSE_MS);
    });
    try {
      try {
        if (this.child.connected) this.child.send({ op: "close", id: 0 }, () => {});
      } catch {
        // Keep the watchdog armed even if IPC has already failed.
      }
      await Promise.race([this.exited, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
