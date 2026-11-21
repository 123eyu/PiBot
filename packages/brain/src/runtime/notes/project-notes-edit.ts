import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { z } from "zod";

const BOM = String.fromCharCode(0xfeff);

const OPEN = "<!-- pibot:notes -->";
const CLOSE = "<!-- /pibot:notes -->";
export const projectNotesInput = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .refine((value) => !value.includes("\0")),
  previous: z
    .string()
    .max(256 * 1024)
    .nullable(),
});

export const notesHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** No caller-chosen path, and no whole-file regeneration by the model. */
export function projectNotesEdit(input: z.infer<typeof projectNotesInput>, language: "zh" | "en") {
  const invalid = () => new RpcError(RpcErrorCodes.invalidParams, "project_notes_invalid");
  const before = input.previous ?? "";
  if (before.includes("\0") || [OPEN, CLOSE].some((marker) => input.text.includes(marker)))
    throw invalid();
  const start = before.indexOf(OPEN),
    end = before.indexOf(CLOSE);
  if (
    start < 0 !== end < 0 ||
    (start >= 0 &&
      (end < start ||
        before.indexOf(OPEN, start + OPEN.length) >= 0 ||
        before.indexOf(CLOSE, end + CLOSE.length) >= 0))
  )
    throw invalid();
  if (
    start >= 0 &&
    [start, end].some((offset) => {
      const marker = offset === start ? OPEN : CLOSE;
      return (
        // A file may open with a UTF-8 BOM right before the marker; it is kept as-is.
        (offset > 0 && before[offset - 1] !== "\n" && !(offset === 1 && before[0] === BOM)) ||
        !["", "\n", "\r\n"].some(
          (eol) =>
            before.slice(offset + marker.length).startsWith(eol) &&
            (eol !== "" || offset + marker.length === before.length),
        )
      );
    })
  )
    throw invalid();
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const title = language === "zh" ? "Pi Bot 记下的项目背景" : "Project notes from Pi Bot";
  const section = [OPEN, `## ${title}`, "", input.text.replace(/\r?\n/g, eol), CLOSE].join(eol);
  const oldSection = start >= 0 ? before.slice(start, end + CLOSE.length) : "";
  const content =
    start >= 0
      ? before.slice(0, start) + section + before.slice(end + CLOSE.length)
      : before + (before && !before.endsWith("\n") ? eol : "") + section + eol;
  if (Buffer.byteLength(content) > 256 * 1024) throw invalid();
  const diff = [
    "--- AGENTS.md",
    "+++ AGENTS.md",
    ...oldSection
      .split(/\r?\n/)
      .filter(() => !!oldSection)
      .map((line) => `-${line}`),
    ...section.split(/\r?\n/).map((line) => `+${line}`),
  ].join("\n");
  return { content, diff, expectedHash: input.previous === null ? null : notesHash(before) };
}

export function projectNotesPath(root: string, platform: string) {
  return (platform === "win32" ? win32 : posix).join(root, "AGENTS.md");
}
