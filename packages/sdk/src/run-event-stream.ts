import type { RunEventPage, RunEventSummary } from "@pibot/protocol";
import { z } from "zod";

const StreamOptionsSchema = z.strictObject({
  runId: z.uuidv4(),
  afterSeq: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().positive().max(200).optional(),
  pollIntervalMs: z.number().int().min(100).max(60_000).optional(),
  follow: z.boolean().optional(),
});
const TimeoutSchema = z.number().int().positive().max(2_147_483_647);

export interface RunEventStreamOptions {
  runId: string;
  afterSeq?: number;
  limit?: number;
  pollIntervalMs?: number;
  /** Keep polling through the durable `run.sealed` watermark. False consumes one complete page. */
  follow?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RunEventPageReader = (
  params: { runId: string; afterSeq: number; limit?: number },
  options: { signal: AbortSignal; timeoutMs?: number },
) => Promise<RunEventPage>;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    timer = setTimeout(done, ms);
  });
}

export async function* createRunEventStream(
  read: RunEventPageReader,
  input: RunEventStreamOptions,
  lifetime: AbortSignal,
): AsyncGenerator<RunEventSummary, void, void> {
  const { signal: callerSignal, timeoutMs, ...wireInput } = input;
  const options = StreamOptionsSchema.parse(wireInput);
  const parsedTimeout = timeoutMs === undefined ? undefined : TimeoutSchema.parse(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([lifetime, callerSignal]) : lifetime;
  let afterSeq = options.afterSeq ?? 0;
  const follow = options.follow ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  let conversationId: string | undefined;

  while (true) {
    signal.throwIfAborted();
    const page = await read(
      { runId: options.runId, afterSeq, ...(options.limit ? { limit: options.limit } : {}) },
      { signal, ...(parsedTimeout === undefined ? {} : { timeoutMs: parsedTimeout }) },
    );
    for (const event of page.events) {
      if (conversationId !== undefined && event.conversationId !== conversationId)
        throw new TypeError("Run event conversation changed");
      conversationId = event.conversationId;
      afterSeq = event.seq;
      yield event;
    }
    afterSeq = page.nextSeq;
    if (!follow) return;
    if (page.settled) return;
    if (page.events.length) continue;
    await wait(pollIntervalMs, signal);
  }
}
