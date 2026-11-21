import type { ChatPeer } from "@pibot/client-core";
import type { MethodResults } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";

type Page = MethodResults["groups.files.list"];
export class GroupFileBrowser {
  private snapshot: Page & { busy: boolean; error?: "load" | "open" } = {
    entries: [],
    rootToken: "",
    truncated: false,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private active = false;
  private generation = 0;
  constructor(
    readonly peer: ChatPeer,
    readonly groupId: string,
    readonly path: string,
    readonly folderId?: string,
    readonly preview?: (
      name: string,
      source: NonNullable<MethodResults["groups.files.open"]["preview"]>,
    ) => void,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  start() {
    this.active = true;
    this.generation++;
    this.lifetime = new AbortController();
    this.snapshot = { entries: [], rootToken: "", truncated: false, busy: false };
    void this.load(true);
    return () => {
      this.active = false;
      this.generation++;
      this.lifetime.abort();
    };
  }
  private async run<T>(kind: "load" | "open", action: (requestId: string) => Promise<T>) {
    if (!this.active || this.snapshot.busy) return undefined;
    const generation = this.generation;
    const requestId = crypto.randomUUID();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(25_000)]);
    const cancel = () => {
      void this.peer.call("groups.files.cancel", { groupId: this.groupId, requestId }).catch(() => {
        // Disconnection prevents remote cancellation; server deadline/stop still owns cleanup.
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.publish({ busy: true, error: undefined });
    try {
      const result = await waitRpc(() => action(requestId), signal);
      signal.throwIfAborted();
      return generation === this.generation ? result : undefined;
    } catch {
      if (generation === this.generation && !this.lifetime.signal.aborted)
        this.publish({ error: kind });
      return undefined;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (generation === this.generation) this.publish({ busy: false });
    }
  }
  load = async (replace = false) => {
    if (!replace && !this.snapshot.cursor) return;
    const generation = this.generation;
    const before = replace ? undefined : this.snapshot.cursor;
    const page = await this.run("load", (requestId) =>
      this.peer.call("groups.files.list", {
        groupId: this.groupId,
        folderId: this.folderId,
        requestId,
        path: this.path,
        cursor: before,
        limit: 50,
      }),
    );
    if (!page || generation !== this.generation || !this.active) return;
    if (
      (!replace && page.rootToken !== this.snapshot.rootToken) ||
      (before && page.cursor === before)
    ) {
      this.publish({ error: "load" });
      return;
    }
    const old = replace ? [] : this.snapshot.entries;
    const seen = new Set(old.map((entry) => entry.path));
    this.publish({
      ...page,
      entries: [...old, ...page.entries.filter((entry) => !seen.has(entry.path))],
    });
  };
  open = async (path: string) => {
    if (
      this.snapshot.error === "load" ||
      !this.snapshot.entries.some((entry) => entry.path === path && entry.kind === "file")
    )
      return;
    const result = await this.run("open", (requestId) =>
      this.peer.call("groups.files.open", {
        groupId: this.groupId,
        folderId: this.folderId,
        requestId,
        path,
        rootToken: this.snapshot.rootToken,
      }),
    );
    if (result?.preview && this.active)
      this.preview?.(path.split("/").at(-1) ?? path, result.preview);
  };
}
