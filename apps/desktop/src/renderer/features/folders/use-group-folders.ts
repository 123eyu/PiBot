import type { TranslationKey } from "@pibot/i18n";
import type { Group } from "@pibot/protocol";
import {
  type FolderEntry,
  type FolderModel,
  folderError,
  type Peer,
  useRunners,
  useT,
} from "@pibot/renderer-kit";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A group's own folders through the same picker as a DM topic. Without a primary the
 * group works in its own data folder. Running plans retain their original selection.
 */
export function useGroupFolders({
  peer,
  group,
  running,
  changed,
}: {
  peer: Pick<Peer, "call" | "on"> | null;
  group?: Group;
  running: boolean;
  /** The authoritative group came back from a folder RPC. */
  changed(group: Group): void;
}): FolderModel | undefined {
  const t = useT();
  const runners = useRunners(peer);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ groupId: string; key: TranslationKey }>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const groupId = group?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another group owns new requests; late replies of the old one change nothing.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPending(false);
    return () => controller.abort();
  }, [groupId, peer]);
  return useMemo(() => {
    if (!group) return undefined;
    const folders = group.folders ?? [];
    const entry = (folder: (typeof folders)[number]): FolderEntry => ({
      id: folder.id,
      name: folder.location
        ? `${runners.find((runner) => runner.id === folder.location)?.name ?? t("remote.runner.kind")} · ${folder.name}`
        : folder.name,
      path: folder.displayPath,
      location: folder.location,
    });
    const primary = folders.find((folder) => folder.id === group.primaryFolderId);
    const run = async (call: (signal?: AbortSignal) => Promise<Group>) => {
      if (!peer) return undefined;
      const signal = lifetime.current?.signal;
      setPending(true);
      setError(undefined);
      try {
        const result = await call(signal);
        if (signal?.aborted || result.id !== group.id) return undefined;
        changed(result);
        return result;
      } catch (failure) {
        if (!signal?.aborted) setError({ groupId: group.id, key: folderError(failure) });
        return undefined;
      } finally {
        if (!signal?.aborted) setPending(false);
      }
    };
    const setPrimary = (folderId: string | null) =>
      run((signal) =>
        (peer as Pick<Peer, "call">).call(
          "groups.folders.setPrimary",
          { groupId: group.id, folderId },
          { signal },
        ),
      );
    return {
      runners,
      browseRunner: peer
        ? (location, path, signal) =>
            peer.call(
              "workplaces.browse",
              { location, ...(path !== undefined ? { path } : {}) },
              { signal },
            )
        : undefined,
      pickRunner: (location, path, target) => {
        if (target === "readonly" && primary?.location !== location) return;
        void run((signal) =>
          (peer as Pick<Peer, "call">).call(
            "groups.folders.add",
            { groupId: group.id, location, path },
            { signal },
          ),
        ).then((result) => {
          const added =
            result?.folders?.find(
              (folder) =>
                folder.location === location &&
                !folders.some((previous) => previous.id === folder.id),
            ) ??
            result?.folders?.find((folder) => folder.location === location && folder.path === path);
          if (result && added && target !== "readonly" && result.primaryFolderId !== added.id)
            void setPrimary(added.id);
        });
      },
      primary: primary ? entry(primary) : { id: "home", name: t("folders.groupHome") },
      readonly: folders.filter((folder) => folder.id !== primary?.id).map(entry),
      recent: [],
      busy: running,
      pending,
      error: error?.groupId === group.id ? error.key : undefined,
      homeLabel: "folders.groupHome",
      setPrimary: (id) => void setPrimary(id === "home" ? null : id),
      // Group folders are shared by the group; "only" never drops the others here.
      setOnly: (id) => void setPrimary(id === "home" ? null : id),
      setReadonly: (id) => {
        if (id === primary?.id) void setPrimary(null);
      },
      remove: (id) =>
        void run((signal) =>
          (peer as Pick<Peer, "call">).call(
            "groups.folders.remove",
            { groupId: group.id, folderId: id },
            { signal },
          ),
        ),
      pick: (target, create = false) => {
        const before = new Set(folders.map((folder) => folder.id));
        void run((signal) =>
          (peer as Pick<Peer, "call">).call(
            "groups.folders.add",
            { groupId: group.id, ...(create ? { create: true } : {}) },
            { signal, timeoutMs: 680_000 },
          ),
        ).then((result) => {
          const added = result?.folders?.find((folder) => !before.has(folder.id));
          if (!result || !added) return;
          // The first folder of a group becomes primary by itself; honour the choice.
          if (target !== "readonly" && result.primaryFolderId !== added.id)
            void setPrimary(added.id);
          if (target === "readonly" && result.primaryFolderId === added.id) void setPrimary(null);
        });
      },
    };
  }, [group, peer, running, pending, error, changed, t, runners]);
}
