import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CacheRequestReceiptSchema as receipt } from "../../packages/protocol-base/src/execution/diagnostics.ts";

const labels = ["<1m", "1–5m", "5–10m", ">10m"] as const;
type Bucket = {
  api: string;
  interval: string;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  hitRate: number;
};

/** Exact request gaps from existing value-free diagnostics; assistant-message timestamps are not requests. */
export async function cacheRequestGaps(dataDir: string, limit: number) {
  const root = join(dataDir, "logs");
  const files = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const buckets = new Map<string, Bucket>();
  let bytes = 0,
    sampled = 0,
    unknownInterval = 0,
    missingUsage = 0;
  let truncated = false;
  for (const name of files
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .reverse()
    .slice(0, 14)) {
    const path = join(root, name);
    const info = await stat(path);
    if (bytes + info.size > 512 * 1024 * 1024) {
      truncated = true;
      break;
    }
    bytes += info.size;
    const recent: Array<{
      api: string;
      intervalMs?: number;
      input?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }> = [];
    let seen = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length > 1024 * 1024) continue;
        let raw: unknown;
        try {
          const outer: unknown = JSON.parse(line);
          if (
            !outer ||
            typeof outer !== "object" ||
            !("message" in outer) ||
            typeof outer.message !== "string"
          )
            continue;
          raw = JSON.parse(outer.message);
        } catch {
          continue;
        }
        const parsed = receipt.safeParse(raw);
        if (!parsed.success) continue;
        recent[seen % limit] = parsed.data;
        seen++;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (seen > limit) truncated = true;
    for (
      let position = seen - 1;
      position >= Math.max(0, seen - limit) && sampled < limit;
      position--
    ) {
      const item = recent[position % limit];
      if (!item) continue;
      sampled++;
      if (item.intervalMs === undefined) {
        unknownInterval++;
        continue;
      }
      if (
        item.input === undefined ||
        item.cacheRead === undefined ||
        item.cacheWrite === undefined
      ) {
        missingUsage++;
        continue;
      }
      const index =
        item.intervalMs < 60_000
          ? 0
          : item.intervalMs < 300_000
            ? 1
            : item.intervalMs <= 600_000
              ? 2
              : 3;
      const interval = labels[index];
      const key = `${item.api}:${index}`;
      const bucket = buckets.get(key) ?? {
        api: item.api,
        interval,
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        hitRate: 0,
      };
      bucket.requests++;
      bucket.input += item.input;
      bucket.cacheRead += item.cacheRead;
      bucket.cacheWrite += item.cacheWrite;
      buckets.set(key, bucket);
    }
    if (sampled >= limit) break;
  }
  for (const bucket of buckets.values()) {
    const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite;
    bucket.hitRate = prompt ? Math.round((bucket.cacheRead / prompt) * 10000) / 100 : 0;
  }
  return {
    source: "agent-cache request receipts",
    selection:
      "latest appended matching receipts, newest daily files first; at most 14 files / 512 MiB",
    buckets: [...buckets.values()].sort(
      (a, b) =>
        a.api.localeCompare(b.api) ||
        labels.indexOf(a.interval as (typeof labels)[number]) -
          labels.indexOf(b.interval as (typeof labels)[number]),
    ),
    sampled: Math.min(sampled, limit),
    unknownInterval,
    missingUsage,
    truncated,
  };
}
