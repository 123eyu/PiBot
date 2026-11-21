import pathApi from "node:path";
import { outputRootEnd } from "./workflow-folder.ts";

/** Calendar dates, not just a four-two-two digit shape (February 31 is not a delivery date). */
function datedName(name: string) {
  const match = /^(.+)_([^_]+)_(\d{4})-(\d{2})-(\d{2})$/u.exec(name);
  if (!match) return false;
  const year = Number(match[3]),
    month = Number(match[4]),
    day = Number(match[5]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A location directive only waives the default tree; it never grants access or validates intent. */
export function hasRequestedOutputDirectory(request: string): boolean {
  return (
    /(?:保存|存放|输出|写入|导出)(?:到|至|在)\s*\S|(?:保存|输出|导出)(?:目录|文件夹|位置)(?:为|是|[:：])\s*\S/u.test(
      request,
    ) ||
    /\b(?:save|store|export|write|output)\b[^.!?\n]{0,80}?\b(?:to|in|under)\s+\S/iu.test(request)
  );
}

/** Inspect the full path: workflow folders can already include the topic above the check root. */
export function validOutputName(
  folder: string,
  path: string,
  defaultDirectory = true,
  paths?: typeof import("node:path").posix,
): boolean {
  const { resolve, dirname, basename, extname, sep } = paths ?? pathApi;
  const target = resolve(folder, path);
  const directories = dirname(target).split(sep);
  const end = outputRootEnd(directories);
  return (
    (!defaultDirectory || (end >= 0 && directories.length > end)) &&
    datedName(basename(target, extname(target)))
  );
}

/** Only mechanical evidence: numbered references, document type, year and a retrievable locator. */
export function validAcademicReferences(text: string): boolean {
  const heading =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:参考文献|引用文献|References|Bibliography)\s*[:：]?\s*\r?\n/iu.exec(
      text,
    );
  if (!heading) return false;
  const section = text.slice(heading.index + heading[0].length).split(/\n\s*#{1,6}\s+/u)[0] ?? "";
  const entries = section.split(/(?:^|\n)\s*\[\d{1,4}\]\s*/u).slice(1);
  return (
    entries.length > 0 &&
    entries.length <= 200 &&
    entries.every(
      (entry) =>
        /\[(?:J|M|C|D|R|S|P|N|EB|DB|CP|A|Z)(?:\/(?:OL|CD|DK|MT))?\]/iu.test(entry) &&
        /\b(?:19|20)\d{2}\b/u.test(entry) &&
        /(?:https?:\/\/\S+|\b10\.\d{4,9}\/\S+)/iu.test(entry),
    )
  );
}
