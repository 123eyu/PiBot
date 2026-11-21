import { type Attachment, base64Bytes } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useRef } from "react";
import { AttachmentMenu } from "./AttachmentMenu.tsx";
import styles from "./attachments.module.css";
import type { AttachmentIssue, DraftAttachment } from "./useAttachments.ts";

export function FileCard({ name, size }: Pick<Attachment, "name" | "size">) {
  return (
    <>
      <span aria-hidden="true" className={styles.fileIcon}>
        <Icon name="file" />
      </span>
      <span className={styles.fileLabel}>
        <strong>{name}</strong>
        <small>
          {/* Maintainers 2026-11-16: a 21-byte file read "0.0 KB" and looked empty. */}
          {size < 1024
            ? `${size} B`
            : size < 1024 * 1024
              ? `${(size / 1024).toFixed(1)} KB`
              : `${(size / 1024 / 1024).toFixed(1)} MB`}
        </small>
      </span>
    </>
  );
}
export function AttachmentButton({
  disabled,
  add,
  organize,
}: {
  disabled: boolean;
  add(files: File[]): Promise<void>;
  /** Opens manual compaction for a long topic; omitted where there is nothing to organize. */
  organize?: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        className={styles.hidden}
        type="file"
        multiple
        onChange={(event) => {
          void add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <AttachmentMenu
        label={t("attachments.menu")}
        disabled={disabled}
        items={[
          {
            id: "attachment",
            label: t("attachments.add"),
            select: () => input.current?.click(),
            icon: <IconTile icon="file" tone="blue" size="sm" />,
          },
          ...(organize
            ? [
                {
                  id: "organize",
                  label: t("chat.compactMenu"),
                  select: organize,
                  icon: <IconTile icon="menu" tone="violet" size="sm" />,
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

export function AttachmentDropOverlay({ active }: { active: boolean }) {
  const t = useT();
  return active ? (
    <div className={styles.dropOverlay} role="status">
      <div className={styles.dropPrompt}>{t("attachments.drop")}</div>
    </div>
  ) : null;
}

export function AttachmentIssues({
  issues,
  openModels,
  dismiss,
}: {
  issues: AttachmentIssue[];
  openModels(): void;
  dismiss(id: string): void;
}) {
  const t = useT();
  return issues.length ? (
    <div className={styles.issues} role="alert">
      {issues.map((issue) => (
        <div key={issue.id} className={styles.issue}>
          <span>
            <strong className={styles.issueName}>{issue.name}</strong>
            {t(issue.key)}
          </span>
          <Button
            variant="ghost"
            aria-label={t("workspace.close")}
            onClick={() => dismiss(issue.id)}
          >
            <Icon name="close" size={14} />
          </Button>
          {issue.key === "attachments.imageUnsupported" && (
            <Button variant="ghost" onClick={openModels}>
              {t("chat.goToSettings")}
            </Button>
          )}
        </div>
      ))}
    </div>
  ) : null;
}
export function AttachmentDrafts({
  drafts,
  disabled,
  remove,
}: {
  drafts: DraftAttachment[];
  disabled: boolean;
  remove(id: string): void;
}) {
  const t = useT();
  if (!drafts.length) return null;
  return (
    <section className={styles.strip} aria-label={t("attachments.pending")}>
      {drafts.map(({ id, input }) => (
        <div className={styles.draft} key={id}>
          {input.kind === "image" ? (
            <img
              className={styles.thumbnail}
              src={`data:${input.mimeType};base64,${input.data}`}
              alt={input.name}
            />
          ) : (
            <FileCard name={input.name} size={base64Bytes(input.data)} />
          )}
          <Button
            variant="ghost"
            disabled={disabled}
            className={styles.remove}
            aria-label={t("attachments.remove", { name: input.name })}
            onClick={() => remove(id)}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
    </section>
  );
}

export function RetryAttachmentDrafts({
  attachments,
  disabled,
  remove,
}: {
  attachments: Attachment[];
  disabled: boolean;
  remove(id: string): void;
}) {
  const t = useT();
  if (!attachments.length) return null;
  return (
    <section className={styles.strip} aria-label={t("attachments.pending")}>
      {attachments.map((item) => (
        <div className={styles.draft} key={item.id}>
          <FileCard name={item.name} size={item.size} />
          <Button
            variant="ghost"
            disabled={disabled}
            className={styles.remove}
            aria-label={t("attachments.remove", { name: item.name })}
            onClick={() => remove(item.id)}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
    </section>
  );
}
