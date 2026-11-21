import { createHash } from "node:crypto";
import type { AuditDetail } from "@pibot/protocol-base";

export interface CachedWebResult {
  text: string;
  isError?: boolean;
  detail: AuditDetail;
  domain: string;
  urls: string[];
  skipCache?: boolean;
  fallbackReason?: "http_status" | "anti_bot_page" | "js_required";
}

/** Owned by one LocalRun, never a global fetch cache or an authorization receipt. */
export class RunWebCache {
  private readonly entries = new Map<string, Promise<CachedWebResult>>();
  private readonly completed = new Set<string>();
  key(input: unknown) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }
  get(key: string) {
    return this.entries.get(key);
  }
  put(key: string, pending: Promise<CachedWebResult>) {
    // Do not evict active work: overlapping duplicates must share the same request.
    while (this.entries.size >= 32) {
      const oldest = this.completed.values().next().value;
      if (!oldest) return;
      this.completed.delete(oldest);
      this.entries.delete(oldest);
    }
    this.entries.set(key, pending);
    void pending.then(
      (value) => {
        if (this.entries.get(key) !== pending) return;
        if (value.skipCache || value.text.length > 1_100_000) this.entries.delete(key);
        else this.completed.add(key);
      },
      () => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
      },
    );
  }
  clear() {
    this.entries.clear();
    this.completed.clear();
  }
}

/** A duplicate caller can cancel its own wait without cancelling the original fetch. */
export function waitWebResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const done = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      done();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => {
        done();
        resolve(value);
      },
      (error) => {
        done();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
