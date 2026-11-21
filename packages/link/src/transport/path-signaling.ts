import type { Port } from "@pibot/protocol-base";
import { utf8 } from "../core/bytes.ts";
import { type PathControl, PathControlSchema } from "./path-control.ts";

/** Buffers bounded trickle ICE while the platform asynchronously creates its RTC peer. */
export class PathSignaling {
  private listeners = new Set<(message: unknown) => void>();
  private queued: unknown[] = [];
  private count = 0;
  private bytes = 0;
  constructor(
    private readonly options: {
      enabled(): boolean;
      offer(): void;
      control(message: PathControl): void;
      fail(): void;
    },
  ) {}
  receive(message: Record<string, unknown>) {
    if (typeof message.method !== "string" || !message.method.startsWith("link.")) return false;
    if (message.method.startsWith("link.direct.")) {
      if (!this.options.enabled()) return true;
      this.count++;
      this.bytes += utf8(JSON.stringify(message)).length;
      if (this.count > 260 || this.bytes > 768 * 1024) {
        this.options.fail();
        return true;
      }
      if (this.listeners.size) for (const fn of this.listeners) fn(message);
      else {
        this.queued.push(message);
        if (message.method === "link.direct.offer") this.options.offer();
      }
    } else {
      const parsed = PathControlSchema.safeParse(message);
      if (!parsed.success) this.options.fail();
      else this.options.control(parsed.data);
    }
    return true;
  }
  port(raw: Port): Port {
    return {
      post: (message) => raw.post(message),
      onMessage: (listener) => {
        this.listeners.add(listener);
        queueMicrotask(() => {
          if (!this.listeners.has(listener)) return;
          for (const message of this.queued.splice(0)) listener(message);
        });
        return () => this.listeners.delete(listener);
      },
    };
  }
  reset() {
    this.queued.length = 0;
    this.count = 0;
    this.bytes = 0;
  }
}
