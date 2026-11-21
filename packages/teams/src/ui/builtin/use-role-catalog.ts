// Own picker requests so late installs cannot navigate a different connection or language.
import type { TranslationKey } from "@pibot/i18n";
import type { BuiltinCatalog, RoleCatalogEntry, RoleCatalogState } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { catalogFailure } from "./catalog-model.ts";

export function useRoleCatalog(target?: { kind: "role" | "group"; id: string; version: number }) {
  const { peer } = useRpc();
  const { language } = useSettings();
  const scope = useMemo(
    () => ({ peer, language, abort: new AbortController(), locked: false, revision: 0 }),
    [peer, language],
  );
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; value: RoleCatalogState }>();
  const [installed, setInstalled] = useState<{ scope: typeof scope; value: BuiltinCatalog }>();
  const [activity, setActivity] = useState<{ scope: typeof scope; key: string }>();
  const [failure, setFailure] = useState<{ scope: typeof scope; key: TranslationKey }>();
  const state = snapshot?.scope === scope ? snapshot.value : undefined;
  const error = failure?.scope === scope ? failure.key : undefined;
  useLayoutEffect(() => {
    // An effect generation owns both reads and mutations, including StrictMode remounts.
    scope.abort = new AbortController();
    const signal = scope.abort.signal;
    const revision = scope.revision;
    if (scope.peer) {
      // No automatic-check preference exists: opening the picker only reads disk state.
      void scope.peer.call("roleCatalog.get", undefined, { signal, timeoutMs: 15000 }).then(
        (value) => {
          if (!signal.aborted && scope.revision === revision) setSnapshot({ scope, value });
        },
        (caught: unknown) => {
          if (!signal.aborted && scope.revision === revision)
            setFailure({ scope, key: catalogFailure(caught) });
        },
      );
    }
    return () => scope.abort.abort();
  }, [scope]);

  async function run<T>(key: string, work: (signal: AbortSignal) => Promise<T>) {
    if (!peer || scope.locked || scope.abort.signal.aborted) return;
    scope.locked = true;
    scope.revision += 1;
    setActivity({ scope, key });
    setFailure(undefined);
    const signal = scope.abort.signal;
    try {
      const result = await work(signal);
      if (!signal.aborted) return result;
    } catch (caught) {
      if (!signal.aborted) setFailure({ scope, key: catalogFailure(caught) });
    } finally {
      scope.locked = false;
      if (!signal.aborted) setActivity(undefined);
    }
  }

  async function check() {
    await run("check", async (signal) => {
      if (!peer) return;
      const value = await peer.call("roleCatalog.check", undefined, { signal, timeoutMs: 75000 });
      if (!signal.aborted) setSnapshot({ scope, value });
      // A timed-out install may have finished on the server; refresh its usable content too.
      const catalog = await peer.call("builtin.catalog", undefined, { signal, timeoutMs: 30000 });
      if (!signal.aborted) setInstalled({ scope, value: catalog });
    });
  }

  // A link to a version the cached catalog does not have yet asks the library once; whatever
  // that check returns, the result stands (targetMissing below), so a missing id cannot loop.
  const targetChecked = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: check is a request helper
  useLayoutEffect(() => {
    if (!target || !state || state.status === "untrusted" || state.status === "unavailable") return;
    const key = `${target.kind}:${target.id}:${target.version}`;
    if (targetChecked.current === key) return;
    const entry = state.entries.find((item) => item.kind === target.kind && item.id === target.id);
    if (entry && entry.version >= target.version) return;
    targetChecked.current = key;
    void check();
  }, [state, target]);

  async function install(entry: RoleCatalogEntry) {
    return run(`${entry.kind}:${entry.id}`, async (signal) => {
      if (!peer) return;
      await peer.call(
        "roleCatalog.install",
        { kind: entry.kind, id: entry.id },
        { signal, timeoutMs: 120000 },
      );
      // A successful download is not a usable role until the merged catalog reads back.
      const value = await peer.call("builtin.catalog", undefined, { signal, timeoutMs: 30000 });
      const item =
        entry.kind === "role"
          ? value.roles.find((role) => role.id === entry.id)
          : value.groups.find((group) => group.id === entry.id);
      if (!item || item.version < entry.version) throw new Error("installed_catalog_unavailable");
      const next = await peer.call("roleCatalog.get", undefined, { signal, timeoutMs: 15000 });
      if (!signal.aborted) {
        setInstalled({ scope, value });
        setSnapshot({ scope, value: next });
      }
      return value;
    });
  }

  return {
    language,
    state,
    error,
    check,
    install,
    catalog: installed?.scope === scope ? installed.value : undefined,
    busy: activity?.scope === scope ? activity.key : undefined,
    offline: state?.error === "offline" || error === "builtin.cloud.offline",
    connected: !!peer,
    targetMissing:
      !!target &&
      !!state &&
      state.status !== "never" &&
      !state.entries.some(
        (entry) =>
          entry.kind === target.kind && entry.id === target.id && entry.version >= target.version,
      ),
  };
}
export type RoleCatalogBrowser = ReturnType<typeof useRoleCatalog>;
