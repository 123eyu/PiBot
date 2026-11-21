import {
  type BackgroundPreferences,
  BackgroundPreferencesPatchSchema,
  IndependentBackgroundMethods,
  type IndependentBackgroundState,
  IndependentBackgroundStateSchema,
} from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { backgroundPreferencesEditable } from "../../../shared/background-presentation.ts";

interface Bridge {
  serviceState(): Promise<IndependentBackgroundState>;
  preferences(patch: Partial<BackgroundPreferences>): Promise<IndependentBackgroundState>;
  stopService(): Promise<{ status: "requested" }>;
}
export interface BackgroundSettingsSnapshot {
  state?: IndependentBackgroundState;
  known: boolean;
  reading: boolean;
  saving: boolean;
  stopping: boolean;
  stopRequested: boolean;
  uncertain: boolean;
  failed: boolean;
}
export const initialBackgroundSnapshot: BackgroundSettingsSnapshot = {
  known: false,
  reading: false,
  saving: false,
  stopping: false,
  stopRequested: false,
  uncertain: false,
  failed: false,
};

/** Slots follow real bridge settlement; a local timeout cannot spawn more in-flight work. */
export class BackgroundSettingsState {
  private snapshot = { ...initialBackgroundSnapshot };
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(value: BackgroundSettingsSnapshot) => void>();
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private read?: Promise<IndependentBackgroundState>;
  private write?: Promise<IndependentBackgroundState>;
  private stop?: Promise<{ status: "requested" }>;
  private readCancel?: AbortController;
  private writeCancel?: AbortController;
  constructor(private readonly bridge: Bridge) {}
  subscribe(listener: (value: BackgroundSettingsSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<BackgroundSettingsSnapshot>) {
    if (this.lifetime.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private poll() {
    clearTimeout(this.timer);
    if (!this.lifetime.signal.aborted) this.timer = setTimeout(() => void this.refresh(), 5000);
  }
  private accept(state: IndependentBackgroundState) {
    const changedOwner = this.snapshot.state && this.snapshot.state.instance !== state.instance;
    this.publish({
      state,
      known: true,
      failed: false,
      uncertain: false,
      ...(changedOwner || state.lifecycle === "stopped" ? { stopRequested: false } : {}),
    });
  }
  async refresh() {
    if (this.lifetime.signal.aborted || this.read || this.write || this.stop) return;
    clearTimeout(this.timer);
    const revision = this.revision;
    const cancel = new AbortController();
    this.readCancel = cancel;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      cancel.signal,
      AbortSignal.timeout(30_000),
    ]);
    this.publish({ reading: true });
    const read = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.bridge.serviceState();
    });
    this.read = read;
    const settled = () => {
      if (this.read !== read) return;
      this.read = undefined;
      this.publish({ reading: false });
      this.poll();
    };
    void read.then(settled, settled);
    try {
      const state = IndependentBackgroundStateSchema.parse(await waitRpc(() => read, signal));
      if (!signal.aborted && revision === this.revision) this.accept(state);
    } catch {
      if (!this.lifetime.signal.aborted && !cancel.signal.aborted && revision === this.revision)
        this.publish({ known: false, failed: true });
    }
  }
  async save(input: Partial<BackgroundPreferences>) {
    const state = this.snapshot.state;
    if (
      this.lifetime.signal.aborted ||
      this.write ||
      this.stop ||
      this.snapshot.stopRequested ||
      !this.snapshot.known ||
      !state ||
      !backgroundPreferencesEditable(state)
    )
      return;
    const patch = BackgroundPreferencesPatchSchema.parse(input);
    if (patch.showTrayWhenBackground !== undefined && state.backgroundTrayAvailable !== true)
      return;
    const revision = ++this.revision;
    this.readCancel?.abort();
    const cancel = new AbortController();
    this.writeCancel = cancel;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      cancel.signal,
      AbortSignal.timeout(30_000),
    ]);
    this.publish({ saving: true, failed: false });
    const write = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.bridge.preferences(patch);
    });
    this.write = write;
    const settled = () => {
      if (this.write !== write) return;
      this.write = undefined;
      this.publish({ saving: false });
      this.poll();
    };
    void write.then(settled, settled);
    try {
      const result = IndependentBackgroundStateSchema.parse(await waitRpc(() => write, signal));
      if (!signal.aborted && revision === this.revision) this.accept(result);
    } catch {
      if (!this.lifetime.signal.aborted && !cancel.signal.aborted && revision === this.revision)
        this.publish({ known: false, failed: true, uncertain: true });
    }
  }
  async stopService() {
    if (
      this.lifetime.signal.aborted ||
      this.stop ||
      this.snapshot.stopRequested ||
      (this.snapshot.known &&
        (this.snapshot.state?.lifecycle === "unsupported" ||
          this.snapshot.state?.lifecycle === "stopped"))
    )
      return;
    const revision = ++this.revision;
    this.readCancel?.abort();
    this.writeCancel?.abort();
    this.publish({ stopping: true, known: false, failed: false });
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]);
    const stop = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.bridge.stopService();
    });
    this.stop = stop;
    const settled = () => {
      if (this.stop !== stop) return;
      this.stop = undefined;
      this.publish({ stopping: false });
      this.poll();
    };
    void stop.then(settled, settled);
    try {
      IndependentBackgroundMethods["background.stopService"].result.parse(
        await waitRpc(() => stop, signal),
      );
      if (!signal.aborted && revision === this.revision)
        this.publish({ stopRequested: true, uncertain: false });
    } catch {
      if (!this.lifetime.signal.aborted && revision === this.revision)
        this.publish({ failed: true, uncertain: true });
    }
  }
  dispose() {
    this.lifetime.abort();
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
