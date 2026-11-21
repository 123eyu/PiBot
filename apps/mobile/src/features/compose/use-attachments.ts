import { useEffect, useRef, useState } from "react";
import { useText } from "../../runtime/context.tsx";
import type { PendingFile } from "../../transport/link-port.ts";
import { useToast } from "../../ui/toast.tsx";
import { discardShared, MESSAGE_ROOM, prepareFiles } from "../share/prepare-native.ts";
import { type PickSource, pickNative } from "./pick-native.ts";

/**
 * The composer's attached files: prepared into the share store as soon as they are
 * picked, so a send only hands their names to the outbox. A draft belongs to one computer and
 * topic like the text; switching away or leaving the chat drops its copies.
 */
export function useAttachments(draftKey: string) {
  const t = useText(),
    toast = useToast();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [preparing, setPreparing] = useState(false);
  // Refs, not state: the "+" sheet starts a pick after it has closed, from a stale render.
  const current = useRef<PendingFile[]>([]);
  const generation = useRef(0);
  const busy = useRef(false);
  const update = (next: PendingFile[]) => {
    current.current = next;
    setFiles(next);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft belongs to the device and topic.
  useEffect(() => {
    update([]);
    setPreparing(false);
    return () => {
      generation.current++;
      discardShared(current.current);
      current.current = [];
    };
  }, [draftKey]);
  const room = () => ({
    count: MESSAGE_ROOM.count - current.current.length,
    bytes: MESSAGE_ROOM.bytes - current.current.reduce((sum, file) => sum + file.bytes, 0),
  });
  return {
    files,
    preparing,
    full: files.length >= MESSAGE_ROOM.count,
    async add(source: PickSource) {
      if (busy.current) return;
      const left = room();
      if (left.count <= 0) return toast(t("attachFullHint"));
      busy.current = true;
      const started = generation.current;
      try {
        const picked = await pickNative(source, left.count);
        if (!picked?.length || started !== generation.current) return;
        setPreparing(true);
        const prepared = await prepareFiles(picked, left);
        if (started !== generation.current) {
          discardShared(prepared.files);
          return;
        }
        update([...current.current, ...prepared.files]);
        if (prepared.skipped) toast(t("attachSkipped", { count: prepared.skipped }));
      } catch (error) {
        toast(
          t(
            error instanceof Error && error.message === "native_cancelled"
              ? "attachCameraDenied"
              : "attachFailed",
          ),
        );
      } finally {
        busy.current = false;
        if (started === generation.current) setPreparing(false);
      }
    },
    remove(blob: string) {
      const file = current.current.find((f) => f.blob === blob);
      if (!file) return;
      discardShared([file]);
      update(current.current.filter((f) => f !== file));
    },
    /**
     * Takes the files for a send before it is awaited, so leaving the chat meanwhile cannot delete
     * copies the outbox is about to own. Hand them back with `restore` if the send is refused.
     */
    take() {
      const taken = current.current;
      update([]);
      return { files: taken, generation: generation.current };
    },
    restore(taken: { files: PendingFile[]; generation: number }) {
      if (taken.generation === generation.current) update([...taken.files, ...current.current]);
      else discardShared(taken.files);
    },
  };
}
export type ComposerAttachments = ReturnType<typeof useAttachments>;
