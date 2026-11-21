import type { MethodResults } from "@pibot/protocol";
import { layoutStyles, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import type { PermissionEditorProps } from "./permission-editor.ts";

export function PathImport({ data, disabled, save }: PermissionEditorProps) {
  const t = useT();
  const { peer } = useRpc();
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<MethodResults["permissions.paths.discover"]>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    if (peer) setFailed(false);
    setPreview(undefined);
    setConfirm(false);
    setBusy(false);
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [peer]);
  const discover = async (source: "process" | "terminal") => {
    if (!peer || disabled || busy) return;
    const token = ++epoch.current;
    setConfirm(false);
    setBusy(true);
    setFailed(false);
    try {
      const result = await peer.call("permissions.paths.discover", { source });
      if (epoch.current === token) setPreview(result);
    } catch {
      if (epoch.current === token) setFailed(true);
    } finally {
      if (epoch.current === token) setBusy(false);
    }
  };
  const merged = [...new Set([...(data.pathEntries ?? []), ...(preview?.paths ?? [])])];
  return (
    <>
      <div className={layoutStyles.labelled}>
        <Button
          variant="secondary"
          className={layoutStyles.small}
          disabled={disabled || busy}
          onClick={() => void discover("process")}
        >
          {t("paths.process")}
        </Button>
        {window.pibot.platform !== "win32" && (
          <Button
            variant="secondary"
            className={layoutStyles.small}
            disabled={disabled || busy}
            onClick={() => {
              setPreview(undefined);
              setConfirm(true);
            }}
          >
            {t("paths.terminal")}
          </Button>
        )}
      </div>
      {confirm && (
        <div className={layoutStyles.banner} role="note">
          <span>{t("paths.shellWarning")}</span>
          <Button
            className={layoutStyles.small}
            disabled={disabled || busy}
            onClick={() => void discover("terminal")}
          >
            {t("paths.read")}
          </Button>
          <Button variant="ghost" className={layoutStyles.small} onClick={() => setConfirm(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
      {busy && (
        <p role="status" className={layoutStyles.note}>
          {t("paths.loading")}
        </p>
      )}
      {failed && (
        <p role="alert" className={layoutStyles.alert}>
          {t("paths.error")}
        </p>
      )}
      {preview && (
        <div className={layoutStyles.inset}>
          <p className={layoutStyles.note}>
            {t(preview.source === "terminal" ? "paths.sourceTerminal" : "paths.sourceProcess", {
              shell: preview.shell ?? "",
            })}
          </p>
          <ul className={layoutStyles.pathList}>
            {preview.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <div className={layoutStyles.labelled}>
            <Button
              className={layoutStyles.small}
              disabled={disabled || busy || merged.length > 200 || !preview.paths.length}
              onClick={() =>
                void save({ pathEntries: merged }).then((ok) => {
                  if (ok) setPreview(undefined);
                })
              }
            >
              {t("paths.apply")}
            </Button>
            <Button
              variant="ghost"
              className={layoutStyles.small}
              onClick={() => setPreview(undefined)}
            >
              {t("common.cancel")}
            </Button>
          </div>
          {merged.length > 200 && (
            <p role="alert" className={layoutStyles.alert}>
              {t("paths.tooMany")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
