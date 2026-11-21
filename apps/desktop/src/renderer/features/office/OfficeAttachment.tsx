import type { Attachment } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { useContext } from "react";
import { FileCard } from "../chat/composer/Attachments.tsx";
import attachmentStyles from "../chat/composer/attachments.module.css";
import { attachmentTarget } from "../file-preview/state.ts";
import { OfficePreviewContext } from "./preview-context.tsx";

export { officeFormat } from "@pibot/office/ui";

export function OfficeAttachment({
  attachment,
  messageId,
  readOnly,
}: {
  attachment: Attachment;
  messageId: string;
  readOnly: boolean;
}) {
  const { peer } = useRpc();
  const t = useT();
  const preview = useContext(OfficePreviewContext);
  return (
    <button
      type="button"
      className={attachmentStyles.fileButton}
      disabled={readOnly || !peer || !preview}
      onClick={() => preview?.(attachmentTarget(attachment, messageId))}
      aria-label={`${t("office.contentPreview")} · ${attachment.name}`}
      title={t("office.contentPreview")}
    >
      <FileCard name={attachment.name} size={attachment.size} />
    </button>
  );
}
