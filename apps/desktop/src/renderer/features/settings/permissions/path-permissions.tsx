import { layoutStyles, SettingsRow, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useId, useState } from "react";
import { PathImport } from "./path-import.tsx";
import type { PermissionEditorProps } from "./permission-editor.ts";

function parseEntries(text: string) {
  return [
    ...new Set(
      text
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
const validEntry = (value: string) =>
  !/[\p{Cc}\p{Cf}]/u.test(value) &&
  (value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\"));

/**
 * Saved when the text area loses focus; no separate save button. One row with the
 * count; 编辑 opens the list and the import flow under it.
 */
export function PathPermissions({ data, disabled, save }: PermissionEditorProps) {
  const t = useT();
  const pathKey = data.pathEntries?.join("\n") ?? "";
  const [paths, setPaths] = useState(pathKey);
  const [invalidPaths, setInvalidPaths] = useState(false);
  useEffect(() => {
    setPaths(pathKey);
  }, [pathKey]);
  const commit = () => {
    const entries = parseEntries(paths);
    if (entries.join("\n") === pathKey) return;
    if (entries.length > 200 || !entries.every(validEntry)) {
      setInvalidPaths(true);
      return;
    }
    setInvalidPaths(false);
    void save({ pathEntries: entries });
  };
  const [open, setOpen] = useState(false);
  const editorId = useId();
  const count = data.pathEntries?.length ?? 0;
  return (
    <>
      <SettingsRow
        icon="terminal"
        tone="teal"
        label={t("permissions.paths")}
        note={count ? t("permissions.pathsCount", { count }) : t("permissions.pathsNone")}
        info={
          <>
            <p>{t("permissions.pathsNote")}</p>
            <p>{t("paths.importNote")}</p>
          </>
        }
      >
        <Button
          variant={open ? "secondary" : "ghost"}
          className={layoutStyles.small}
          aria-expanded={open}
          aria-controls={editorId}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? "permissions.collapse" : "permissions.edit")}
        </Button>
      </SettingsRow>
      {open && (
        <div id={editorId} className={layoutStyles.editor}>
          <PathImport data={data} disabled={disabled} save={save} />
          <textarea
            className={layoutStyles.textarea}
            aria-label={t("permissions.paths")}
            value={paths}
            disabled={disabled}
            rows={3}
            onChange={(event) => setPaths(event.currentTarget.value)}
            onBlur={commit}
          />
          {invalidPaths && (
            <p role="alert" className={layoutStyles.alert}>
              {t("permissions.pathsInvalid")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
