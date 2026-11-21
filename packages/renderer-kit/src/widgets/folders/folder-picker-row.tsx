import { Icon, IconTile } from "@pibot/ui";
import { useT } from "../../settings/context.ts";
import styles from "./folders.module.css";
import { type FolderEntry, type FolderModel, MAX_REFERENCES } from "./selection.ts";

export function FolderPickerRow({
  folder,
  role,
  model,
  locked,
  act,
}: {
  folder: FolderEntry;
  role: "primary" | "readonly" | "writable";
  model: FolderModel;
  locked: boolean;
  act(action: () => void): () => void;
}) {
  const t = useT();
  const home = folder.id === "home";
  const label =
    role === "readonly"
      ? "folders.readonly"
      : role === "primary" && model.writable
        ? "folders.primaryWritable"
        : "folders.writable";
  return (
    <li className={styles.row} data-folder-role={role}>
      <IconTile
        icon={home ? "home" : "folder"}
        tone={role === "readonly" ? "teal" : role === "writable" ? "orange" : "amber"}
      />
      <span className={styles.rowName} title={folder.path}>
        <span className={styles.name}>{folder.name}</span>
        {folder.path && <span className={styles.path}>{folder.path}</span>}
      </span>
      <span className={role === "readonly" ? styles.tag : styles.tagPrimary}>{t(label)}</span>
      {!home && (
        <span className={styles.rowActions}>
          {role !== "writable" && (
            <button
              type="button"
              className={styles.mini}
              disabled={locked || (role === "primary" && model.readonly.length >= MAX_REFERENCES)}
              onClick={act(() =>
                role === "primary" ? model.setReadonly(folder.id) : model.setPrimary(folder.id),
              )}
            >
              {t(role === "primary" ? "folders.makeReadonly" : "folders.makePrimary")}
            </button>
          )}
          <button
            type="button"
            className={styles.miniIcon}
            disabled={locked}
            aria-label={t("folders.removeNamed", { name: folder.name })}
            title={t("folders.remove")}
            onClick={act(() => model.remove(folder.id))}
          >
            <Icon name="close" size={13} />
          </button>
        </span>
      )}
    </li>
  );
}
