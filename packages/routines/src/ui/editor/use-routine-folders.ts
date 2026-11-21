import type { TranslationKey } from "@pibot/i18n";
import type {
  FolderSelection,
  MethodResults,
  RoutineDraft,
  WorkingFolder,
  Workplaces,
} from "@pibot/protocol";
import {
  type FolderEntry,
  type FolderModel,
  folderError,
  type RunnerPickTarget,
  useRpc,
  useRunners,
  useT,
  without,
  withPrimary,
  withReadonly,
} from "@pibot/renderer-kit";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A routine's own folders in its editor, with the chat's picker. A routine still saved as
 * `{kind:"bot"}` (a model proposal) shows the new-topic default; the brain saves it that way too.
 */
export function useRoutineFolders(
  botId: string,
  workplace: RoutineDraft["workplace"],
  registry: Workplaces | undefined,
  change: (workplace: RoutineDraft["workplace"]) => void,
) {
  const { peer } = useRpc();
  const t = useT();
  const [initial, setInitial] = useState<{
    botId: string;
    value: MethodResults["topics.workplace.initial"];
  }>();
  const [picked, setPicked] = useState(() => new Map<string, WorkingFolder>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const runners = useRunners(peer);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Bot owns new requests.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPending(false);
    setError(undefined);
    return () => controller.abort();
  }, [botId]);
  const follows = workplace.kind === "bot";
  useEffect(() => {
    if (!peer || !botId || !follows) return;
    const abort = new AbortController();
    void peer
      .call("topics.workplace.initial", { botId }, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setInitial({ botId, value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("folders.failed");
      });
    return () => abort.abort();
  }, [peer, botId, follows]);
  const inherited = initial?.botId === botId ? initial.value : undefined;
  const selection: FolderSelection | undefined =
    workplace.kind === "folder"
      ? { primary: workplace.folderId, readonly: workplace.readonly ?? [] }
      : inherited?.selection;
  const names = useMemo(() => {
    const map = new Map<string, FolderEntry>();
    const runnerNames = new Map(runners.map((entry) => [entry.id, entry.name]));
    const add = (f: Pick<WorkingFolder, "id" | "name" | "path" | "location">) =>
      map.set(f.id, {
        id: f.id,
        name: f.location?.startsWith("runner:")
          ? `${runnerNames.get(f.location) ?? t("remote.runner.kind")} · ${f.name}`
          : f.name,
        path: f.path,
        location: f.location,
      });
    for (const folder of registry?.folders ?? []) add(folder);
    for (const folder of inherited?.workplace.folders ?? []) add(folder);
    for (const folder of picked.values()) add(folder);
    return map;
  }, [registry, inherited, picked, runners, t]);
  const apply = (next: FolderSelection) =>
    change({ kind: "folder", folderId: next.primary, readonly: next.readonly });
  const entry = (id: string): FolderEntry =>
    id === "home"
      ? { id, name: t("folders.home") }
      : (names.get(id) ?? { id, name: t("topicWorkplace.missing") });
  const model: FolderModel | undefined = selection && {
    primary: entry(selection.primary),
    readonly: selection.readonly.map(entry),
    recent: [...(registry?.folders ?? [])]
      .filter((f) => f.id !== selection.primary && !selection.readonly.includes(f.id))
      .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
      .slice(0, 8)
      .map((f) => entry(f.id)),
    busy: false,
    pending,
    error,
    runners,
    browseRunner: peer
      ? (location, path, signal) =>
          peer.call(
            "workplaces.browse",
            { location, ...(path !== undefined && { path }) },
            { signal },
          )
      : undefined,
    pickRunner: (location: string, path: string, target: RunnerPickTarget) => {
      if (!peer || !botId) return;
      const signal = lifetime.current?.signal;
      setPending(true);
      setError(undefined);
      void peer
        .call("workplaces.pick", { botId, location, path }, { signal })
        .then(({ folder }) => {
          if (signal?.aborted || !folder) return;
          setPicked((map) => new Map(map).set(folder.id, folder));
          const next =
            target === "readonly"
              ? withReadonly(selection, folder.id)
              : { primary: folder.id, readonly: [] };
          if (next) apply(next);
          else setError("folders.full");
        })
        .catch((failure: unknown) => {
          if (!signal?.aborted) setError(folderError(failure));
        })
        .finally(() => {
          if (!signal?.aborted) setPending(false);
        });
    },
    // A workspace stays on one device; switching devices drops the other device's references.
    setPrimary: (id) =>
      apply(
        (names.get(id)?.location ?? "local") !== (names.get(selection.primary)?.location ?? "local")
          ? { primary: id, readonly: [] }
          : withPrimary(selection, id),
      ),
    setOnly: (id) => apply({ primary: id, readonly: [] }),
    setReadonly: (id) => {
      const next = withReadonly(selection, id);
      if (next) apply(next);
      else setError("folders.full");
    },
    remove: (id) => apply(without(selection, id)),
    pick: (target, create = false) => {
      if (!peer || !botId) return;
      const signal = lifetime.current?.signal;
      setPending(true);
      setError(undefined);
      void peer
        .call("workplaces.pick", { botId, create }, { signal, timeoutMs: 680_000 })
        .then(({ folder }) => {
          if (signal?.aborted || !folder) return;
          setPicked((map) => new Map(map).set(folder.id, folder));
          const next =
            target === "only"
              ? { primary: folder.id, readonly: [] }
              : target === "primary"
                ? (folder.location ?? "local") !==
                  (names.get(selection.primary)?.location ?? "local")
                  ? { primary: folder.id, readonly: [] }
                  : withPrimary(selection, folder.id)
                : withReadonly(selection, folder.id);
          if (next) apply(next);
          else setError("folders.full");
        })
        .catch((failure: unknown) => {
          if (!signal?.aborted) setError(folderError(failure));
        })
        .finally(() => {
          if (!signal?.aborted) setPending(false);
        });
    },
  };
  /** The routine's folders in the shape the preauthorization editor checks scopes against. */
  const places: Workplaces | undefined =
    registry && selection
      ? {
          home: registry.home,
          currentId: selection.primary,
          revision: 0,
          folders: [selection.primary, ...selection.readonly]
            .filter((id) => id !== "home")
            .map((id) => ({
              id,
              name: entry(id).name,
              path: entry(id).path ?? "",
              ...(entry(id).location && { location: entry(id).location }),
              role: id === selection.primary ? ("primary" as const) : ("readonly" as const),
            }))
            .filter((folder) => folder.path),
        }
      : undefined;
  const inherit =
    follows && inherited
      ? { name: entry(inherited.selection.primary).name, active: true, select: () => {} }
      : undefined;
  return { model, places, inherit };
}
