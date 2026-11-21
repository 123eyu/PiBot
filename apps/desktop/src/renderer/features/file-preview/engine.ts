import type { PreviewFile } from "@pibot/protocol";
import type { OpenFile, ReadingState } from "./state.ts";
export interface ViewerProps {
  file: OpenFile;
  result: PreviewFile;
  update(key: string, patch: Partial<ReadingState>): void;
  metadata(value: { total: number; sheets?: string[] }): void;
  ready?(): void;
  fail(): void;
}
