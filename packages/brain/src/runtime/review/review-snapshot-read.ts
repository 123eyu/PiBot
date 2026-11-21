import { matchesGlob, relative, resolve, sep } from "node:path";
import type { LocalToolCall } from "@pibot/agent";
import { ReviewReadSchema, RpcError } from "@pibot/protocol-base";
import type { ReviewSnapshot } from "./review-snapshot.ts";

export function frozenFile(snapshot: ReviewSnapshot, path: string) {
  const file = snapshot.files.find((f) => f.path === path);
  if (!file) throw new RpcError(-32602, "review_snapshot_missing");
  return file.text;
}
function lines(text: string, offset = 0, limit = 2000) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new RpcError(-32602, "review_range_invalid");
  return {
    text: text
      .split("\n")
      .slice(offset, offset + limit)
      .join("\n")
      .slice(0, 64 * 1024),
    partial: true,
  };
}
export function readFrozenSnapshot(
  snapshot: ReviewSnapshot,
  call: LocalToolCall,
  signal: AbortSignal,
): unknown {
  const relativePath = (path: unknown) =>
    typeof path === "string"
      ? relative(snapshot.root, resolve(snapshot.root, path)).split(sep).join("/")
      : "";
  const path = relativePath(call.input.path);
  if (call.tool === "review_read") {
    const args = ReviewReadSchema.parse(call.input);
    if (args.kind === "manifest")
      return {
        hash: snapshot.reviewHash,
        files: snapshot.files
          .slice(args.offset ?? 0, (args.offset ?? 0) + Math.min(args.limit ?? 100, 200))
          .map(({ path, hash }) => ({ path, hash })),
        total: snapshot.files.length,
        reasons: snapshot.reasons,
        partial: true,
      };
    return lines(
      args.kind === "diff" ? snapshot.diff : frozenFile(snapshot, relativePath(args.path)),
      args.offset,
      args.limit,
    );
  }
  if (call.tool === "read_file")
    return lines(
      frozenFile(snapshot, path),
      Number(call.input.offset ?? 0),
      Number(call.input.limit ?? 2000),
    );
  const selected = snapshot.files.filter(
    (f) => !path || path === "." || f.path === path || f.path.startsWith(`${path}/`),
  );
  if (call.tool === "list_dir" || call.tool === "find_files") {
    const pattern = typeof call.input.pattern === "string" ? call.input.pattern : undefined;
    return {
      files: selected
        .filter(
          (f) => !pattern || matchesGlob(f.path, pattern) || matchesGlob(f.path, `**/${pattern}`),
        )
        .slice(0, 200)
        .map(({ path }) => ({ path })),
      partial: true,
    };
  }
  if (call.tool !== "search_text") throw new RpcError(-32602, "review_readonly");
  const query = String(call.input.query ?? "");
  if (!query || query.length > 1000) throw new RpcError(-32602, "review_search_invalid");
  const matches: { path: string; line: number; text: string }[] = [];
  const sensitive = call.input.caseSensitive === true,
    needle = sensitive ? query : query.toLocaleLowerCase();
  for (const file of selected) {
    for (const [index, text] of file.text.split("\n").entries()) {
      signal.throwIfAborted();
      if ((sensitive ? text : text.toLocaleLowerCase()).includes(needle))
        matches.push({ path: file.path, line: index + 1, text: text.slice(0, 240) });
      if (matches.length >= 200) return { matches, partial: true };
    }
  }
  return { matches, partial: true };
}
