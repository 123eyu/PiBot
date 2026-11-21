import { ExecError } from "../core/types.ts";
import type { TextEdit } from "./replace-text.ts";

export type PatchFile =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; edits: TextEdit[] };

/**
 * What was wrong and where (1-based line of the patch text). A bare invalid_input left the model
 * guessing: a dev Bot had half its patches rejected and could not tell why (Codex's
 * apply_patch reports the line too). Still an ExecError("invalid_input") for everything else.
 */
export type PatchFormatProblem =
  | "envelope"
  | "file_header"
  | "hunk_header"
  | "line_prefix"
  | "add_line_prefix"
  | "hunk_without_change"
  | "empty_update"
  | "limits";
export class PatchFormatError extends ExecError {
  constructor(
    readonly problem: PatchFormatProblem,
    readonly line?: number,
  ) {
    super("invalid_input");
  }
}

/** A deliberately small text format: no moves, shell commands or binary patch execution. */
export function parsePatch(patch: string): PatchFile[] {
  if (
    Buffer.byteLength(patch) > 1024 * 1024 ||
    patch.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(patch)
  )
    throw new PatchFormatError("limits");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
    throw new PatchFormatError("envelope");
  const result: PatchFile[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(lines[cursor++] ?? "");
    // +1 for "*** Begin Patch", which was shifted off.
    if (!header) throw new PatchFormatError("file_header", cursor + 1);
    if (result.length >= 50) throw new PatchFormatError("limits");
    const path = header[2] as string;
    if (!path.trim() || path.length > 32768 || /[\p{Cc}\p{Cf}]/u.test(path))
      throw new PatchFormatError("file_header", cursor + 1);
    if (header[1] === "Delete") {
      result.push({ kind: "delete", path });
      continue;
    }
    if (header[1] === "Add") {
      const body: string[] = [];
      while (cursor < lines.length && !lines[cursor]?.startsWith("*** ")) {
        const line = lines[cursor++] as string;
        // A model often drops the "+" of an empty line; it can only mean an empty line here.
        if (line !== "" && !line.startsWith("+"))
          throw new PatchFormatError("add_line_prefix", cursor + 1);
        body.push(line.slice(1));
      }
      result.push({ kind: "add", path, content: body.length ? `${body.join("\n")}\n` : "" });
      continue;
    }
    const edits: TextEdit[] = [];
    while (cursor < lines.length && !lines[cursor]?.startsWith("*** ")) {
      if (!/^@@(?: .*|$)/u.test(lines[cursor++] ?? ""))
        throw new PatchFormatError("hunk_header", cursor + 1);
      if (edits.length >= 50) throw new PatchFormatError("limits");
      const old: string[] = [],
        next: string[] = [];
      let changed = false;
      while (
        cursor < lines.length &&
        !lines[cursor]?.startsWith("@@") &&
        !lines[cursor]?.startsWith("*** ")
      ) {
        // An empty line is an empty context line whose leading space was trimmed (the most
        // common model mistake); it still has to match the file exactly.
        const line = (lines[cursor++] as string) || " ";
        if (![" ", "+", "-"].includes(line[0] ?? ""))
          throw new PatchFormatError("line_prefix", cursor + 1);
        if (line[0] !== "+") old.push(line.slice(1));
        if (line[0] !== "-") next.push(line.slice(1));
        if (line[0] !== " ") changed = true;
      }
      // An insertion needs a context line so it has a unique location; never guess an empty needle.
      if (!changed || !old.length) throw new PatchFormatError("hunk_without_change", cursor + 1);
      const eof = lines[cursor] === "*** End of File";
      if (eof) cursor++;
      edits.push({
        old: `${old.join("\n")}\n`,
        new: next.length ? `${next.join("\n")}\n` : "",
        lineBased: true,
        ...(eof ? { endOfFile: true } : {}),
      });
    }
    if (!edits.length) throw new PatchFormatError("empty_update", cursor + 1);
    result.push({ kind: "update", path, edits });
  }
  if (!result.length) throw new PatchFormatError("envelope");
  return result;
}
