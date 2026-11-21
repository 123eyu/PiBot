import { type BrowserRecordEvent, BrowserRecordEventSchema } from "@pibot/browser-contract/full";

const MAX_RECORD = 5000;

/** Raw "teach it once" events for T10; validated before they are kept or forwarded. */
export class Recording {
  private events: BrowserRecordEvent[] | undefined;
  /** While paused (the user signs in) nothing is kept, not even the event kind. */
  paused = false;
  /** While > 0 nothing is kept (an automatic login fill must never be recorded). */
  private muted = 0;

  constructor(
    private readonly forward: (event: BrowserRecordEvent) => void,
    /** Keyframes: called with the index of every kept event. */
    private readonly kept?: (index: number) => void,
  ) {}

  get active() {
    return !!this.events;
  }

  start() {
    this.paused = false;
    this.events ??= [];
  }

  /** Suppresses events until the returned function runs (idempotent). */
  mute() {
    this.muted++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.muted--;
    };
  }

  stop() {
    const events = this.events ?? [];
    this.events = undefined;
    this.paused = false;
    return events;
  }

  /** Events from `after` on (the live step list polls this while recording). */
  read(after: number) {
    return (this.events ?? []).slice(after);
  }

  /** Payload from the recorder world's binding; page-provided, so parsed and schema-checked. */
  raw(tab: string, payload: string) {
    if (!this.events || this.paused || this.muted > 0) return;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return; // A malformed payload is dropped rather than trusted.
    }
    if (value && typeof value === "object")
      this.add({ ...(value as object), tab, at: Date.now() } as BrowserRecordEvent);
  }

  add(raw: BrowserRecordEvent) {
    if (!this.events || this.paused || this.muted > 0 || this.events.length >= MAX_RECORD) return;
    const event = BrowserRecordEventSchema.safeParse(raw);
    if (!event.success) return;
    this.events.push(event.data);
    this.forward(event.data);
    this.kept?.(this.events.length - 1);
  }
}
