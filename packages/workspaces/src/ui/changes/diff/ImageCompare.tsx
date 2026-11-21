import { useT } from "@pibot/renderer-kit";
import type { ChangesImageSide } from "@pibot/workspaces-contract/full";
import { useEffect, useState } from "react";
import styles from "../changes.module.css";
import { baseName, type ListFile } from "../model.ts";
import { formatCount } from "./FileList.tsx";

export type ImageLoader = (
  side: "before" | "after",
  signal: AbortSignal,
) => Promise<ChangesImageSide>;

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatCount(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Image before / after side by side (the design draws two boxes; no slider).
 * Each side is a small thumbnail made in the main process; the image itself never reaches here.
 */
export function ImageCompare({
  file,
  load,
  openFile,
}: {
  file: ListFile;
  load?: ImageLoader;
  openFile?: () => void;
}) {
  const t = useT();
  const added = file.tag === "A" || file.tag === "U";
  const deleted = file.tag === "D";
  return (
    <div className={styles.imageCompare}>
      <Side
        label={t("changes.diff.before")}
        name={baseName(file.display)}
        absent={added ? t("changes.diff.noBefore") : undefined}
        missingText={t("changes.diff.noBefore")}
        load={load && !added ? (signal) => load("before", signal) : undefined}
        fileKey={file.key}
      />
      <Side
        label={t("changes.diff.after")}
        name={baseName(file.display)}
        absent={deleted ? t("changes.diff.deleted") : undefined}
        missingText={t("changes.diff.deleted")}
        load={load && !deleted ? (signal) => load("after", signal) : undefined}
        fileKey={file.key}
        openFile={deleted ? undefined : openFile}
      />
    </div>
  );
}

function Side({
  label,
  name,
  absent,
  missingText,
  load,
  fileKey,
  openFile,
}: {
  label: string;
  name: string;
  absent?: string;
  /** Shown when the file turns out not to exist on this side. */
  missingText: string;
  load?: (signal: AbortSignal) => Promise<ChangesImageSide>;
  fileKey: string;
  openFile?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<{ side?: ChangesImageSide; error?: boolean }>({});
  const enabled = !!load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one read per file and side
  useEffect(() => {
    setState({});
    if (!load) return;
    const abort = new AbortController();
    load(abort.signal).then(
      (side) => !abort.signal.aborted && setState({ side }),
      () => !abort.signal.aborted && setState({ error: true }),
    );
    return () => abort.abort();
  }, [fileKey, enabled]);
  const side = state.side;
  const missing = absent ?? (side?.state === "missing" ? missingText : undefined);
  if (missing)
    return (
      <div className={styles.imageBox} data-empty>
        <small>{label}</small>
        {missing}
      </div>
    );
  const note =
    state.error || !load
      ? t("changes.diff.imageError")
      : !side
        ? t("changes.diff.imageLoading")
        : side.state === "too_large"
          ? t("changes.diff.imageTooLarge", { size: size(side.bytes) })
          : side.state === "unsupported"
            ? t("changes.diff.imageUnsupported")
            : undefined;
  return (
    <figure className={styles.imageBox} data-loading={(!side && !state.error) || undefined}>
      <small>{label}</small>
      {side?.state === "ok" && (
        <img
          className={styles.imageThumb}
          src={`data:${side.thumbnail.mimeType};base64,${side.thumbnail.data}`}
          alt={name}
          draggable={false}
        />
      )}
      <figcaption>
        <b>{name}</b>
        {side?.state === "ok" && (
          <span>
            {side.width && side.height
              ? t("changes.diff.imageSize", {
                  width: side.width,
                  height: side.height,
                  size: size(side.bytes),
                })
              : t("changes.diff.imageBytes", { size: size(side.bytes) })}
          </span>
        )}
        {note && <span>{note}</span>}
      </figcaption>
      {openFile && (
        <button type="button" className={styles.miniAccent} onClick={openFile}>
          {t("changes.diff.open")}
        </button>
      )}
    </figure>
  );
}
