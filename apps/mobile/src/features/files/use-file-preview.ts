import { useEffect, useRef, useState } from "react";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import type { CacheEntry } from "../../storage/file-cache.ts";
import { fileErrorKey } from "./errors.ts";
import { fetchPreviewFile } from "./fetch-file.ts";
import type { FileSource } from "./source.ts";

export interface FilePreviewState {
  entry?: CacheEntry;
  uri?: string;
  text?: string;
  stale: boolean;
  progress?: number;
  loading: boolean;
  error?: MobileKey;
}
/**
 * One file fetched through the encrypted session into the phone cache (image, text, markdown).
 * Re-runs when the computer, connection or source changes; leaving the page cancels the read.
 */
export function useFilePreview(source: FileSource | undefined, name: string, wantsText: boolean) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const [state, setState] = useState<FilePreviewState>({ stale: false, loading: false });
  const [attempt, setAttempt] = useState(0);
  const lastProgress = useRef(0);
  const shownKey = useRef("");
  const online = mobile.status === "online";
  const connecting = mobile.status === "connecting";
  const key = source ? JSON.stringify(source) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the source key, device and connection own the read.
  useEffect(() => {
    const computerId = mobile.selectedId;
    if (!source || !computerId) return;
    const abort = new AbortController();
    // A reconnect refreshes the same file in place; only a different file clears the view.
    if (shownKey.current !== key) setState({ stale: false, loading: true });
    else setState((s) => ({ ...s, loading: true, error: undefined }));
    shownKey.current = key;
    lastProgress.current = 0;
    void (async () => {
      try {
        const fetched = await fetchPreviewFile(
          runtime,
          runtime.storage.files,
          {
            computerId,
            online,
            source,
            name,
            onProgress(done, total) {
              const progress = total ? done / total : 1;
              // Re-render at most every 10%; a 20 MB image has ~36 slices.
              if (progress - lastProgress.current < 0.1 && progress < 1) return;
              lastProgress.current = progress;
              if (!abort.signal.aborted) setState((s) => ({ ...s, progress }));
            },
          },
          abort.signal,
        );
        const text = wantsText ? await runtime.storage.files.readText(fetched.entry) : undefined;
        if (abort.signal.aborted) return;
        setState({
          entry: fetched.entry,
          uri: runtime.storage.files.uri(fetched.entry),
          text,
          stale: fetched.stale,
          loading: false,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const code = fileErrorKey(error);
        // Nothing cached yet and the link is still coming up: keep waiting for it.
        // Keep a copy already on screen; a failed refresh only adds the error line.
        setState((s) =>
          code === "fileOffline" && connecting
            ? { ...s, loading: !s.entry }
            : { ...s, loading: false, error: code },
        );
      }
    })();
    return () => abort.abort();
  }, [key, mobile.selectedId, mobile.peer, online, connecting, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
