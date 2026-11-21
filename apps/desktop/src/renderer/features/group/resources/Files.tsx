import type { ChatPeer } from "@pibot/client-core";
import { AppSelect, botPanelStyles as panelStyles, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { OfficePreviewContext } from "../../office/preview-context.tsx";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { GroupFileBrowser } from "./files.ts";

/** Group outputs remain browsable in the own folder before any external folder is associated. */
export function GroupFiles({
  peer,
  data,
  chooseFolder,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  chooseFolder?: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const group = data.group;
  if (!group) return null;
  const folders = group.folders ?? [];
  const effective: string =
    selected !== undefined &&
    (selected === "home" || folders.some((folder) => folder.id === selected))
      ? selected
      : (group.primaryFolderId ?? "home");
  const folder = folders.find((folder) => folder.id === effective);
  return (
    <div className={panelStyles.stack}>
      {effective === "home" && (
        <div className={panelStyles.sectionHead}>
          <span>{t("folders.groupHome")}</span>
          {chooseFolder && (
            <Button variant="ghost" onClick={chooseFolder}>
              {t("panel.chooseFolder")}
            </Button>
          )}
        </div>
      )}
      {folders.length > 0 && (
        <AppSelect
          label={t("group.folders")}
          value={effective}
          change={setSelected}
          options={[
            { value: "home", label: t("folders.groupHome") },
            ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
          ]}
        />
      )}
      <GroupFileEntries
        key={effective}
        peer={peer}
        data={data}
        folderId={effective}
        folderName={folder?.name ?? t("folders.groupHome")}
      />
    </div>
  );
}
function GroupFileEntries({
  peer,
  data,
  folderId,
  folderName,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  folderId?: string;
  folderName: string;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const preview = useContext(OfficePreviewContext);
  const groupId = data.group?.id ?? "";
  const browser = useMemo(
    () =>
      new GroupFileBrowser(peer, groupId, path, folderId, (name, groupFile) =>
        preview?.({ name, source: { groupFile } }),
      ),
    [peer, groupId, path, folderId, preview],
  );
  const state = useSyncExternalStore(browser.subscribe, browser.getSnapshot, browser.getSnapshot);
  useEffect(() => browser.start(), [browser]);
  const count = `${state.entries.length}${state.cursor ? "+" : ""}`;
  return (
    <section className={panelStyles.section} aria-label={t("group.files")} aria-busy={state.busy}>
      <div className={panelStyles.sectionHead}>
        <Icon name="folder" size={14} />
        <h2 title={path || undefined}>{path ? `${folderName} / ${path}` : folderName}</h2>
        {!state.busy && !state.error && (
          <span className={panelStyles.note}>{t("panel.fileCount", { count })}</span>
        )}
      </div>
      {path && (
        <button
          type="button"
          className={panelStyles.link}
          disabled={state.busy}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        >
          {t("group.fileParent")}
        </button>
      )}
      {!!state.entries.length && (
        <div className={panelStyles.card}>
          {state.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className={`${panelStyles.cardRow} ${styles.fileRow}`}
              disabled={
                state.busy || data.error || state.error === "load" || entry.kind === "blocked"
              }
              onClick={() =>
                entry.kind === "directory" ? setPath(entry.path) : void browser.open(entry.path)
              }
            >
              <Icon name={entry.kind === "directory" ? "folder" : "file"} size={16} />
              <span className={panelStyles.rowText}>
                <strong>{entry.name}</strong>
                {entry.kind === "blocked" && <small>{t("group.fileBlocked")}</small>}
              </span>
              {entry.kind === "directory" && <Icon name="chevronRight" size={14} />}
            </button>
          ))}
        </div>
      )}
      {state.busy && (
        <p role="status" className={panelStyles.note}>
          {t("common.loading")}
        </p>
      )}
      {!state.entries.length && !state.busy && !state.error && (
        <p className={panelStyles.note}>{t("group.fileEmpty")}</p>
      )}
      {state.truncated && (
        <p role="status" className={panelStyles.note}>
          {t("group.fileTruncated")}
        </p>
      )}
      {state.error && (
        <p role="alert" className={panelStyles.error}>
          {t(state.error === "load" ? "group.fileLoadFailed" : "group.openFailed")}{" "}
          {state.error === "load" && (
            <Button variant="pill" onClick={() => void browser.load(true)}>
              {t("common.retry")}
            </Button>
          )}
        </p>
      )}
      {state.cursor && (
        <Button
          variant="pill"
          className={panelStyles.more}
          loading={state.busy}
          disabled={state.error === "load"}
          onClick={() => void browser.load()}
        >
          {t("group.fileMore")}
        </Button>
      )}
    </section>
  );
}
