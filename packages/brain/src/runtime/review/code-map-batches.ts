import type { CodeMapResult } from "@pibot/execution/codemap";
import type { CodeMapFileState } from "@pibot/storage";

const MAX_FILES = 128;
const MAX_BYTES = 4 * 1024 * 1024;

type Extract = (
  files: { path: string; text: string; hasCppSibling?: boolean }[],
  signal: AbortSignal,
) => Promise<CodeMapResult>;

/** What the parser failed with (its own code, a worker exit code, a class name), never source. */
function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const detail = (error as { detail?: unknown }).detail;
  return (typeof detail === "string" ? detail : error.message).slice(0, 60) || error.name;
}

function chunks(files: readonly CodeMapFileState[], limit: number): CodeMapFileState[][] {
  const parts: CodeMapFileState[][] = [];
  let part: CodeMapFileState[] = [];
  let bytes = 0;
  for (const file of files) {
    if (part.length >= limit || bytes + file.size > MAX_BYTES) {
      if (part.length) parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(file);
    bytes += file.size;
  }
  if (part.length) parts.push(part);
  return parts;
}

/** Only a performance hint survives calls: never source text, permissions or parser results. */
export class CodeMapBatches {
  private limit = MAX_FILES;

  async *extract(
    extract: Extract,
    files: readonly CodeMapFileState[],
    texts: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): AsyncGenerator<{ files: CodeMapFileState[]; result: CodeMapResult } | { reason: string }> {
    // Grow on the next refresh, not between retries: a successful small retry must not send
    // this refresh straight back into the oversized batch that just timed out.
    let limit = this.limit;
    const pending = chunks(files, limit);
    while (pending.length) {
      signal.throwIfAborted();
      const part = pending.shift() as CodeMapFileState[];
      // An earlier timeout may have lowered the limit after these chunks were queued.
      if (part.length > limit) {
        pending.unshift(...chunks(part, limit));
        continue;
      }
      let result: CodeMapResult;
      try {
        result = await extract(
          // The neighbour fact comes from the authorized walk; dropping it would parse a C++
          // header as C on every refresh.
          part.map((file) => ({
            path: file.path,
            text: texts.get(file.path) as string,
            hasCppSibling: file.hasCppSibling,
          })),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        const timeout = error instanceof Error && error.message === "codemap_timeout";
        if (timeout && part.length > 1) {
          // Retain the smaller size across refreshes: the outer deadline must not make the next
          // refresh repeat all the same oversized attempts before it can save its first file.
          limit = Math.min(limit, Math.ceil(part.length / 2));
          this.limit = limit;
          pending.unshift(...chunks(part, limit));
          continue;
        }
        yield { reason: timeout ? "parser_timeout" : `parser_failed:${errorDetail(error)}` };
        continue;
      }
      signal.throwIfAborted();
      // Only successful batch sizes justify growth; a short final batch must not lower the hint.
      this.limit = Math.min(MAX_FILES, Math.max(this.limit, part.length * 2));
      yield { files: part, result };
    }
  }
}
