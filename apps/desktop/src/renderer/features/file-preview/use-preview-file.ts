import { type PreviewFile, RpcError } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import type { OpenFile, ReadingState } from "./state.ts";
export function usePreviewFile(
  file: OpenFile,
  retry: number,
  update: (key: string, patch: Partial<ReadingState>) => void,
) {
  const { peer } = useRpc();
  const [result, setResult] = useState<PreviewFile>();
  const [error, setError] = useState<string>();
  const revision = file.reading.revision,
    source = file.source,
    key = file.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed read freezes its revision without scheduling another read; the key names the source
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController(),
      requestId = crypto.randomUUID();
    const started = performance.now();
    let done = false;
    const note = (outcome: string, kind = "unknown") =>
      console.info(
        JSON.stringify({
          module: "file-preview",
          event: "rpc",
          kind,
          outcome,
          durationMs: Math.round(performance.now() - started),
        }),
      );
    setResult(undefined);
    setError(undefined);
    const options = { signal: abort.signal, timeoutMs: 35_000 };
    const read =
      "groupFile" in source
        ? peer.call(
            "groups.files.preview",
            { ...source.groupFile, requestId, expectedRevision: revision },
            options,
          )
        : "officeRender" in source
          ? peer.call("office.renderSnapshot", source.officeRender, options)
          : peer.call(
              "preview.read",
              { ...source, requestId, expectedRevision: revision },
              options,
            );
    void read
      .then((value) => {
        if (abort.signal.aborted) return;
        done = true;
        note("ok", value.kind);
        setResult(value);
        update(key, { revision: value.revision });
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          done = true;
          note("preview_failed");
          setError(error instanceof RpcError ? error.message : "preview_failed");
        }
      });
    return () => {
      if (!done) note("aborted");
      abort.abort();
      if (!done && "groupFile" in source)
        void peer
          .call(
            "groups.files.cancel",
            { groupId: source.groupFile.groupId, requestId },
            { timeoutMs: 3000 },
          )
          .catch(() => {
            // Server deadline and group drain retain ownership if the cancel acknowledgement is lost.
          });
      if (!done && !("officeRender" in source) && !("groupFile" in source))
        void peer.call("preview.cancel", { requestId }, { timeoutMs: 3000 }).catch(() => {
          // A lost cancel acknowledgement cannot outlive the server's own 30-second deadline.
        });
    };
  }, [peer, key, retry, update]);
  return { result, error };
}
export function previewBytes(data: string): Uint8Array<ArrayBuffer> {
  const raw = atob(data),
    bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
