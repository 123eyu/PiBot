import { useRpc } from "@pibot/renderer-kit";
import { createContext, useCallback, useEffect, useState } from "react";
import type { SidePaneSlot } from "../side-pane/SidePane.tsx";
import type { SidePaneControl } from "../side-pane/use-side-pane.ts";
import { FilePreviewWorkspace } from "./FilePreviewWorkspace.tsx";
import {
  fileKey,
  initialReading,
  type OpenFile,
  type PreviewTarget,
  type ReadingState,
} from "./state.ts";
export const FilePreviewContext = createContext<((target: PreviewTarget) => void) | undefined>(
  undefined,
);
/** Files belong to one visible conversation and connection. Inactive engines are never retained. */
export function useFilePreview(
  scope: string | undefined,
  pane: SidePaneControl,
  beforeOpen?: () => void,
  visible = true,
) {
  const { peer } = useRpc();
  const [workspace, setWorkspace] = useState<{
    scope: string;
    peer: typeof peer;
    files: OpenFile[];
    active: string;
  }>();
  const current = workspace?.scope === scope && workspace?.peer === peer ? workspace : undefined;
  const show = pane.show;
  const open = useCallback(
    (target: PreviewTarget) => {
      if (!scope || !peer) return;
      beforeOpen?.();
      const key = fileKey(target);
      setWorkspace((previous) => {
        const files =
          previous && previous.scope === scope && previous.peer === peer ? previous.files : [];
        // Bounded metadata only. At capacity replace the oldest tab with the requested file; file contents are never retained.
        return {
          scope,
          peer,
          active: key,
          files: files.some((file) => file.key === key)
            ? files.map((file) =>
                file.key === key ? { ...file, reopened: (file.reopened ?? 0) + 1 } : file,
              )
            : [...files.slice(-11), { ...target, key, reading: initialReading() }],
        };
      });
      show("preview");
    },
    [scope, peer, beforeOpen, show],
  );
  const update = useCallback(
    (key: string, patch: Partial<ReadingState>) =>
      setWorkspace((previous) =>
        previous && previous.scope === scope && previous.peer === peer
          ? {
              ...previous,
              files: previous.files.map((file) =>
                file.key === key ? { ...file, reading: { ...file.reading, ...patch } } : file,
              ),
            }
          : previous,
      ),
    [scope, peer],
  );
  const activate = useCallback(
    (key: string) =>
      setWorkspace((previous) =>
        previous &&
        previous.scope === scope &&
        previous.peer === peer &&
        previous.files.some((file) => file.key === key)
          ? { ...previous, active: key }
          : previous,
      ),
    [scope, peer],
  );
  const closeFile = useCallback(
    (key: string) =>
      setWorkspace((previous) => {
        if (!previous || previous.scope !== scope || previous.peer !== peer) return previous;
        const index = previous.files.findIndex((file) => file.key === key),
          files = previous.files.filter((file) => file.key !== key);
        return {
          ...previous,
          files,
          active:
            previous.active === key
              ? (files[Math.min(index, files.length - 1)]?.key ?? "")
              : previous.active,
        };
      }),
    [scope, peer],
  );
  useEffect(() => {
    if (workspace && !current) setWorkspace(undefined);
    if (pane.tab === "preview" && !current?.files.length) pane.close();
  }, [workspace, current, pane.tab, pane.close]);
  const slot: SidePaneSlot = {
    id: "preview",
    content:
      visible && current?.files.length ? (
        <FilePreviewWorkspace
          files={current.files}
          active={current.active}
          activate={activate}
          close={closeFile}
          update={update}
        />
      ) : null,
  };
  return { open, slot, count: current?.files.length ?? 0 };
}
