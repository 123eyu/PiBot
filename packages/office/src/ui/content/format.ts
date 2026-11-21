import type { OfficeFormat } from "@pibot/office-contract/full";

export function officeFormat(name: string): OfficeFormat | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return extension === "docx" || extension === "xlsx" || extension === "pptx"
    ? extension
    : undefined;
}
