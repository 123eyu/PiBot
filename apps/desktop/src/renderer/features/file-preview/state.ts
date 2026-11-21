import type { Attachment, MethodParams, PreviewSource } from "@pibot/protocol";
/** Attachments, run changes, and immutable Office render snapshots. */
export interface PreviewTarget {
  name: string;
  /** A page of a rendered document: the tab label is translated when drawn, not when opened. */
  label?: { page: number; sheet: boolean };
  source:
    | PreviewSource
    | { groupFile: Omit<MethodParams["groups.files.preview"], "requestId" | "expectedRevision"> }
    | { officeRender: MethodParams["office.renderSnapshot"] };
}
export interface ReadingState {
  page: number;
  sheet: number;
  zoom: number;
  x: number;
  y: number;
  appId?: string;
  revision?: string;
  sheets: Record<number, { x: number; y: number }>;
}
export interface OpenFile extends PreviewTarget {
  key: string;
  reading: ReadingState;
  /** Times the user opened this tab again; a failed read retries on the next open. */
  reopened?: number;
}
export const initialReading = (): ReadingState => ({
  page: 0,
  sheet: 0,
  zoom: 1,
  x: 0,
  y: 0,
  sheets: {},
});
export const attachmentTarget = (attachment: Attachment, messageId: string): PreviewTarget => ({
  name: attachment.name,
  source: { attachmentId: attachment.id, messageId },
});
export const fileKey = ({ source }: PreviewTarget) =>
  "groupFile" in source
    ? `group-file:${JSON.stringify(source.groupFile)}`
    : "officeRender" in source
      ? `office-render:${JSON.stringify(source.officeRender)}`
      : "runId" in source
        ? `run:${source.runId}:${source.path}`
        : `${source.messageId}:${source.attachmentId}`;
