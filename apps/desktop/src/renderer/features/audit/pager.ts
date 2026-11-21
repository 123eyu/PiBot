import { type AuditFilter, auditKinds, auditMatches } from "@pibot/client-core";
import type { AuditEntry, AuditKind, AuditQuery } from "@pibot/protocol";
import { auditRead } from "./rpc.ts";

type Stream = {
  kind?: AuditKind;
  before?: string;
  done: boolean;
  buffer: AuditEntry[];
  cursors: Set<string>;
};
/** Merge the existing single-kind cursors; never pass a filtered row as the raw page cursor. */
export function commandKey(entry: AuditEntry) {
  return `${entry.botId}:${entry.runId}:${entry.detail.toolCallId}`;
}
export class AuditPager {
  readonly sources = new Map<string, AuditEntry>();
  private streams: Stream[];
  constructor(
    private readonly fetch: (query: AuditQuery) => Promise<AuditEntry[]>,
    private readonly filter: AuditFilter,
    private readonly botId?: string,
    private readonly cutoff?: string,
    private readonly showInternal = false,
    private readonly visibleLimit = 50,
  ) {
    this.streams = auditKinds(filter).map((kind) => ({
      kind,
      done: false,
      buffer: [],
      cursors: new Set(),
    }));
  }
  get more() {
    return this.streams.some((stream) => stream.buffer.length || !stream.done);
  }
  async next(signal: AbortSignal): Promise<AuditEntry[]> {
    const result: AuditEntry[] = [];
    let rounds = 0;
    const consumed = new Map<Stream, AuditEntry[]>();
    try {
      while (result.length < this.visibleLimit) {
        signal.throwIfAborted();
        const empty = this.streams.filter((stream) => !stream.done && !stream.buffer.length);
        if (empty.length) {
          // Sparse categories get a bounded scan per click, with an explicit continuation.
          if (rounds++ >= 5) break;
          const reads = await Promise.allSettled(empty.map((stream) => this.fill(stream, signal)));
          const failure = reads.find((read) => read.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          if (this.streams.some((stream) => !stream.done && !stream.buffer.length)) continue;
        }
        const stream = this.streams
          .filter((stream) => stream.buffer.length)
          .sort((a, b) => {
            const left = a.buffer[0],
              right = b.buffer[0];
            return left && right
              ? right.at.localeCompare(left.at) || right.id.localeCompare(left.id)
              : 0;
          })[0];
        const entry = stream?.buffer.shift();
        if (!entry || !stream) break;
        result.push(entry);
        const staged = consumed.get(stream);
        if (staged) staged.push(entry);
        else if (stream) consumed.set(stream, [entry]);
      }
      return result;
    } catch (error) {
      for (const [stream, entries] of consumed) stream.buffer.unshift(...entries);
      throw error;
    }
  }
  private async fill(stream: Stream, signal: AbortSignal) {
    const page = await auditRead(
      () =>
        this.fetch({
          limit: 200,
          ...(this.botId ? { botId: this.botId } : {}),
          ...(stream.kind ? { kind: stream.kind } : {}),
          ...(stream.before ? { before: stream.before } : {}),
        }),
      signal,
    );
    signal.throwIfAborted();
    if (
      page.some(
        (entry) =>
          (this.botId && entry.botId !== this.botId) || (stream.kind && entry.kind !== stream.kind),
      )
    )
      throw new Error("Audit scope mismatch");
    for (const entry of page) {
      if (entry.kind === "exec.started" && entry.runId && entry.detail.toolCallId) {
        this.sources.set(commandKey(entry), entry);
        if (this.sources.size > 1000) {
          const oldest = this.sources.keys().next().value;
          if (oldest) this.sources.delete(oldest);
        }
      }
    }
    const last = page.at(-1);
    if (last && stream.cursors.has(last.id)) throw new Error("Audit cursor repeated");
    if (last) stream.cursors.add(last.id);
    stream.before = last?.id;
    stream.done = page.length < 200 || !!(last && this.cutoff && last.at < this.cutoff);
    stream.buffer.push(
      ...page.filter(
        (entry) =>
          (!this.cutoff || entry.at >= this.cutoff) &&
          auditMatches(entry, this.filter, this.showInternal),
      ),
    );
  }
}
