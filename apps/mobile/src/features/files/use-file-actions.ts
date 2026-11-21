import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import { useToast } from "../../ui/toast.tsx";
import { fileErrorKey } from "./errors.ts";
import { fetchPreviewFile } from "./fetch-file.ts";
import { openWithApp, type SaveOutcome, saveFile, shareFile } from "./file-actions.ts";
import type { FileSource } from "./source.ts";

const savedText: Record<SaveOutcome, MobileKey | undefined> = {
  photos: "fileSavedPhotos",
  folder: "fileSavedFolder",
  sheet: undefined,
  cancelled: undefined,
};
function actionError(error: unknown): MobileKey {
  const code = error instanceof Error ? error.message : "";
  if (code === "photos_denied") return "filePhotosDenied";
  if (code === "share_unavailable") return "fileShareUnavailable";
  return fileErrorKey(error);
}
/**
 * Save / open with / share on the phone. Each uses the cached file (fetched first if needed:
 * an Office page view does not carry the file itself); offline only a cached copy works.
 */
export function useFileActions(source: FileSource, name: string) {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    t = useText(),
    toast = useToast();
  const action = useAction(`${mobile.selectedId}:file:${JSON.stringify(source)}`, mobile.peer);
  const run = (work: (uri: string) => Promise<MobileKey | undefined>) =>
    action.run(async (signal) => {
      try {
        const computerId = mobile.selectedId;
        if (!computerId) throw new Error("offline");
        const fetched = await fetchPreviewFile(
          runtime,
          runtime.storage.files,
          { computerId, online: mobile.status === "online", source, name },
          signal,
        );
        const message = await work(runtime.storage.files.uri(fetched.entry));
        if (message) toast(t(message));
      } catch (error) {
        if (!signal.aborted) action.setError(actionError(error));
      }
    });
  return {
    busy: action.busy,
    error: action.error,
    save: () => run(async (uri) => savedText[await saveFile(uri, name)]),
    openWith: () =>
      run(async (uri) => {
        await openWithApp(uri, name);
        return undefined;
      }),
    share: () =>
      run(async (uri) => {
        await shareFile(uri, name);
        return undefined;
      }),
  };
}
