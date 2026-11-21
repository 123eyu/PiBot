/** Serial admission for one owner-owned daemon; native operations drain outside the queue. */
export function createMacCuaOwner<Connection>(options: {
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean; required: boolean }>;
  start(): Promise<Connection>;
  restart(): Promise<Connection>;
  stop(): Promise<void>;
  destroy(): void;
  invalidate(): void;
  release(): Promise<void>;
  watch(connection: Connection, exited: () => void, signal: AbortSignal): Promise<void>;
  /** Each failure that seals the owner, with the error the caller would otherwise never see. */
  failed?(code: string, error: unknown): void;
}) {
  let permissions: Awaited<ReturnType<typeof options.permissions>> | undefined;
  let connection: Connection | undefined;
  let started = false;
  let connecting: Promise<Connection> | undefined;
  let closed = false;
  let fault = false;
  let queue = Promise.resolve();
  let watching: AbortController | undefined;
  let watchTask: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const serial = <T>(work: () => Promise<T>) => {
    const operation = queue.then(work);
    queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
  const retire = async () => {
    options.invalidate();
    await Promise.allSettled([...active]);
    await options.release();
    watching?.abort();
    await watchTask;
    watchTask = undefined;
    watching = undefined;
    connection = undefined;
  };
  const observe = (value: Connection) => {
    watching?.abort();
    const current = new AbortController();
    watching = current;
    watchTask = options
      .watch(
        value,
        () => {
          if (current.signal.aborted || closed) return;
          fault = true; // Seal admission immediately, before the queued drain.
          void serial(retire).catch(() => {
            fault = true;
          });
        },
        current.signal,
      )
      .catch(() => {
        if (!current.signal.aborted && !closed) {
          fault = true;
          void serial(retire).catch(() => {
            fault = true;
          });
        }
      });
  };
  const refresh = async () => {
    if (closed) throw new Error("cua_owner_closed");
    if (fault) throw new Error("cua_owner_unavailable");
    let next: Awaited<ReturnType<typeof options.permissions>>;
    try {
      next = await options.permissions();
    } catch (error) {
      fault = true;
      options.failed?.("cua_owner_permissions_unavailable", error);
      await retire();
      throw new Error("cua_owner_permissions_unavailable");
    }
    if (closed) throw new Error("cua_owner_closed");
    const changed =
      permissions !== undefined &&
      (permissions.accessibility !== next.accessibility ||
        permissions.screenRecording !== next.screenRecording);
    permissions = next;
    if (!changed) return;
    try {
      await retire();
      if (closed || !started) return;
      if (next.required) {
        connection = await options.restart();
        observe(connection);
      } else {
        await options.stop();
      }
    } catch (error) {
      fault = true;
      options.failed?.("cua_owner_transition_failed", error);
      throw new Error("cua_owner_transition_failed");
    }
  };
  return {
    get permissions() {
      return permissions;
    },
    refresh: () => serial(refresh),
    /** Called only inside an admitted operation; it never re-enters the admission queue. */
    async connection() {
      if (closed || fault || !permissions?.required) throw new Error("cua_owner_unavailable");
      if (!connection) {
        connecting ??= options
          .start()
          .then((value) => {
            connection = value;
            started = true;
            observe(value);
            return value;
          })
          .catch((error: unknown) => {
            fault = true;
            options.failed?.("cua_owner_start_failed", error);
            throw new Error("cua_owner_start_failed");
          });
        try {
          await connecting;
        } finally {
          connecting = undefined;
        }
      }
      if (!connection) throw new Error("cua_owner_unavailable");
      return connection;
    },
    async run<T>(work: () => Promise<T>, denied: () => T, needsPermissions = true): Promise<T> {
      const admitted = await serial(async () => {
        await refresh();
        if (closed || fault) throw new Error("cua_owner_unavailable");
        if (needsPermissions && !permissions?.required)
          return { operation: Promise.resolve(denied()) };
        const operation = Promise.resolve().then(work);
        active.add(operation);
        void operation.then(
          () => active.delete(operation),
          () => active.delete(operation),
        );
        return { operation };
      });
      return admitted.operation;
    },
    stop() {
      closed = true;
      options.invalidate();
      watching?.abort();
      return serial(async () => {
        // A driver call that never returns would hold retire (and quitting) forever; the driver
        // is stopped regardless after a few seconds, which also ends that call.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          retire().catch((error: unknown) => options.failed?.("cua_retire_failed", error)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
          }),
        ]).finally(() => clearTimeout(timer));
        await options.stop();
        options.destroy();
      });
    },
  };
}
