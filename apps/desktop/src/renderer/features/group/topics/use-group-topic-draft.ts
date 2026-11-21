import type { ChatPeer } from "@pibot/client-core";
import type { FolderSelection, Group } from "@pibot/protocol";
import {
  type FolderEntry,
  type FolderModel,
  folderError,
  useRunners,
  useT,
  without,
  withPrimary,
  withReadonly,
} from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";
export function useGroupTopicDraft(
  peer: ChatPeer,
  group: Group | undefined,
  draftId: string | undefined,
) {
  const runners = useRunners(peer);
  const t = useT(),
    lifetime = useRef(new AbortController());
  const [saved, setSaved] = useState<{
    key?: string;
    selection: FolderSelection;
    folders: FolderEntry[];
    pending: boolean;
    error?: FolderModel["error"];
  }>({ selection: { primary: "home", readonly: [] }, folders: [], pending: false });
  const initial = () => ({
    key: draftId,
    selection: {
      primary: "home",
      readonly: [] as string[],
    },
    folders: (group?.folders ?? []).map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: folder.displayPath,
      location: folder.location,
    })),
    pending: false,
    error: undefined as FolderModel["error"],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft freezes its starting selection, not subsequent group folder edits
  useEffect(() => {
    if (group && draftId) setSaved((previous) => (previous.key === draftId ? previous : initial()));
  }, [group?.id, draftId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft identity owns picker replies
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    setSaved((previous) => ({ ...previous, pending: false }));
    return () => owner.abort();
  }, [draftId, peer, group?.id]);
  const state = saved.key === draftId ? saved : initial();
  const update = (change: (selection: FolderSelection) => FolderSelection) =>
    setSaved((previous) => {
      const current = previous.key === draftId ? previous : initial();
      return { ...current, selection: change(current.selection), error: undefined };
    });
  const raw = (id: string): FolderEntry =>
    state.folders.find((folder) => folder.id === id) ?? {
      id: "home",
      name: t("folders.groupHome"),
    };
  const get = (id: string): FolderEntry => {
    const folder = raw(id);
    return {
      ...folder,
      name: folder.location
        ? `${runners.find((runner) => runner.id === folder.location)?.name ?? t("remote.runner.kind")} · ${folder.name}`
        : folder.name,
    };
  };
  const choosePrimary = (selection: FolderSelection, id: string) =>
    raw(selection.primary).location !== raw(id).location
      ? { primary: id, readonly: [] }
      : withPrimary(selection, id);
  const pick = (
    target: "primary" | "readonly" | "only",
    remote?: { location: string; path: string },
  ) => {
    if (
      !group ||
      !draftId ||
      state.pending ||
      (target === "readonly" && raw(state.selection.primary).location !== remote?.location)
    )
      return;
    const owner = lifetime.current;
    setSaved({ ...state, pending: true, error: undefined });
    void peer
      .call(
        "groups.topics.pickFolder",
        { groupId: group.id, ...remote },
        { signal: owner.signal, timeoutMs: 630000 },
      )
      .then((picked) => {
        if (owner.signal.aborted) return;
        setSaved((previous) => {
          if (previous.key !== draftId) return previous;
          if (!picked) return { ...previous, pending: false };
          const folders = [
            ...previous.folders.filter((folder) => folder.id !== picked.choiceId),
            {
              id: picked.choiceId,
              name: picked.name,
              path: picked.path,
              location: picked.location,
            },
          ];
          const currentLocation = previous.folders.find(
            (folder) => folder.id === previous.selection.primary,
          )?.location;
          const selection =
            target === "only" || (target !== "readonly" && currentLocation !== picked.location)
              ? { primary: picked.choiceId, readonly: [] }
              : target === "readonly"
                ? (withReadonly(previous.selection, picked.choiceId) ?? previous.selection)
                : withPrimary(previous.selection, picked.choiceId);
          return { ...previous, folders, selection, pending: false };
        });
      })
      .catch((error) => {
        if (!owner.signal.aborted)
          setSaved((previous) =>
            previous.key === draftId
              ? { ...previous, pending: false, error: folderError(error) }
              : previous,
          );
      });
  };
  const model: FolderModel = {
    runners,
    browseRunner: (location, path, signal) =>
      peer.call(
        "workplaces.browse",
        { location, ...(path !== undefined ? { path } : {}) },
        { signal },
      ),
    pickRunner: (location, path, target) => pick(target, { location, path }),
    primary: get(state.selection.primary),
    readonly: state.selection.readonly.map(get),
    recent: state.folders
      .filter(
        (folder) =>
          folder.id !== state.selection.primary && !state.selection.readonly.includes(folder.id),
      )
      .map((folder) => get(folder.id)),
    busy: false,
    pending: state.pending,
    error: state.error,
    homeLabel: "folders.groupHome",
    setPrimary: (id) => update((selection) => choosePrimary(selection, id)),
    setOnly: (id) => update(() => ({ primary: id, readonly: [] })),
    setReadonly: (id) =>
      update((selection) =>
        id === selection.primary && raw(id).location
          ? { primary: "home", readonly: [] }
          : raw(id).location === raw(selection.primary).location
            ? (withReadonly(selection, id) ?? selection)
            : selection,
      ),
    remove: (id) =>
      update((selection) =>
        id === selection.primary && raw(id).location
          ? { primary: "home", readonly: [] }
          : without(selection, id),
      ),
    pick: (target) => pick(target),
  };
  const inherited = {
    primary: group?.primaryFolderId ?? "home",
    readonly: (group?.folders ?? [])
      .filter((folder) => folder.id !== group?.primaryFolderId)
      .map((folder) => folder.id),
  };
  return {
    model,
    selection: state.selection,
    inherit: {
      name:
        group?.folders?.find((folder) => folder.id === group.primaryFolderId)?.name ??
        t("folders.groupHome"),
      active: JSON.stringify(state.selection) === JSON.stringify(inherited),
      select: () => setSaved({ ...initial(), selection: inherited }),
    },
  };
}
