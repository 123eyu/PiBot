import { useT } from "@pibot/renderer-kit";
import { Button, Combobox, Icon, IconTile, type Tone } from "@pibot/ui";
import { useEffect, useRef } from "react";
import { FilePreviewPane } from "./FilePreviewPane.tsx";
import styles from "./preview.module.css";
import type { OpenFile, ReadingState } from "./state.ts";
export function FilePreviewWorkspace({
  files,
  active,
  activate,
  close,
  update,
}: {
  files: OpenFile[];
  active: string;
  activate(key: string): void;
  close(key: string): void;
  update(key: string, patch: Partial<ReadingState>): void;
}) {
  const t = useT(),
    tabs = useRef(new Map<string, HTMLButtonElement>());
  const label = (item: OpenFile) =>
    item.label
      ? t(item.label.sheet ? "office.render.tabSheet" : "office.render.tabPage", {
          name: item.name,
          page: item.label.page,
        })
      : item.name;
  const focusFrame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  const closeTab = (key: string, index: number) => {
    const next = active === key ? (files[index + 1] ?? files[index - 1])?.key : active;
    close(key);
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      if (next) tabs.current.get(next)?.focus();
    });
  };
  const file = files.find((item) => item.key === active) ?? files[0];
  return (
    <section className={styles.workspace} aria-label={t("preview.title")}>
      <div className={styles.tabRow}>
        <div className={styles.tabs} role="tablist" aria-label={t("preview.files")}>
          {files.map((item, index) => (
            <div
              key={item.key}
              className={styles.tab}
              data-selected={item.key === active || undefined}
            >
              <button
                type="button"
                role="tab"
                id={`file-tab-${index}`}
                aria-selected={item.key === active}
                aria-controls="file-preview-panel"
                tabIndex={item.key === active ? 0 : -1}
                title={label(item)}
                ref={(node) => {
                  if (node) tabs.current.set(item.key, node);
                  else tabs.current.delete(item.key);
                }}
                onClick={() => activate(item.key)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End", "Delete"].includes(event.key))
                    return;
                  event.preventDefault();
                  if (event.key === "Delete") {
                    closeTab(item.key, index);
                    return;
                  }
                  const next =
                    files[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? files.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + files.length) %
                            files.length
                    ];
                  if (next) {
                    activate(next.key);
                    tabs.current.get(next.key)?.focus();
                    tabs.current
                      .get(next.key)
                      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
                  }
                }}
              >
                <Icon name="file" size={15} data-tone={fileTone(label(item))} />
                <span>{label(item)}</span>
              </button>
              <Button
                variant="ghost"
                className={styles.closeTab}
                title={t("preview.closeFile", { name: label(item) })}
                aria-label={t("preview.closeFile", { name: label(item) })}
                onClick={() => closeTab(item.key, index)}
              >
                <Icon name="close" size={12} />
              </Button>
            </div>
          ))}
        </div>
        <div className={styles.fileMenu} title={t("preview.capacity")}>
          <Combobox
            variant="pill"
            triggerIcon="audit"
            hideLabel
            label={t("preview.files")}
            placeholder={t("preview.files")}
            value={active}
            options={files.map((item) => ({
              value: item.key,
              label: label(item),
              leading: <IconTile icon="file" tone={fileTone(label(item))} size="sm" />,
            }))}
            onValueChange={activate}
            searchPlaceholder={t("combobox.searchPlaceholder")}
            noResultsText={t("combobox.noResults")}
            moreResultsText={(count) => t("combobox.moreResults", { count })}
          />
        </div>
      </div>
      {file && (
        <div
          id="file-preview-panel"
          role="tabpanel"
          aria-labelledby={`file-tab-${files.indexOf(file)}`}
          className={styles.panel}
        >
          <FilePreviewPane key={file.key} file={file} update={update} />
        </div>
      )}
    </section>
  );
}

/** The tab's file mark is tinted by kind so open files are told apart at a glance. */
function fileTone(name: string): Tone {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "pdf") return "red";
  if (["ppt", "pptx", "key", "odp"].includes(extension)) return "orange";
  if (["xls", "xlsx", "csv", "ods", "numbers"].includes(extension)) return "green";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(extension))
    return "pink";
  if (["md", "txt", "doc", "docx", "rtf", "odt", "pages"].includes(extension)) return "blue";
  return "violet";
}
