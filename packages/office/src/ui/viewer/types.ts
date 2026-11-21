import type { PreviewFile } from "@pibot/office-contract/full";
export interface OfficeReadingState {
  page: number;
  sheet: number;
  zoom: number;
  x: number;
  y: number;
}
export interface OfficeViewerProps {
  file: { key: string; name: string; reading: OfficeReadingState };
  result: PreviewFile;
  update(key: string, patch: Partial<OfficeReadingState>): void;
  metadata(value: { total: number; sheets?: string[] }): void;
  ready?(): void;
  fail(): void;
}
