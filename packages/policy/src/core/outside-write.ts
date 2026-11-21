import { canonicalPath, containsPath, pathApi } from "../paths/paths.ts";
import { protectedPaths } from "../paths/protected-paths.ts";
import { OUTSIDE_WRITE_REASON } from "./confirmation-reasons.ts";
import type { EvaluationInput, PathContext, PolicyResult, ResolvedPath } from "./types.ts";

/** A write outside every workplace, asked once for this call only. */
export { OUTSIDE_WRITE_REASON };
/** Root, home itself, system folders, Pi Bot's data and credential stores. */
export const PROTECTED_PATH_REASON = "protected_path";
/** The pre-ADR-0054 hard refusal, kept for runners and callers that cannot show the card. */
export const OUTSIDE_WRITE_DENIED_REASON = "outside_workplace_write_denied";

async function nearestExisting(path: string, context: PathContext) {
  const api = pathApi(context.platform);
  let current = path;
  for (;;) {
    const resolved = await canonicalPath(current, context);
    if (resolved.exists) return resolved.path;
    const parent = api.dirname(current);
    if (parent === current) return resolved.path;
    current = parent;
  }
}

/**
 * Judges the targets that lie outside every workplace and records them on `result` for the card
 * and for execution. Returns the refusal reason instead when they may not even be asked about.
 *
 * The root opened for a command is the target itself, or its nearest existing folder when the
 * target does not exist yet (the sandbox can only allow existing paths), and that root is checked
 * against the protected list too: the whole folder becomes writable for the command. A file tool
 * is bound to its one approved path, so its root is just the nearest existing parent folder.
 */
export async function judgeOutsideWrites(
  targets: readonly ResolvedPath[],
  kind: "file" | "command",
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  remembered?: readonly { folder: string; program: string; path: string }[],
): Promise<string | undefined> {
  if (!targets.length) return undefined;
  // A runner's paths are not something the person at this computer can check on a card.
  if (input.boundary?.location?.target.startsWith("runner:") || !input.protectedWriteRoots)
    return OUTSIDE_WRITE_DENIED_REASON;
  const api = pathApi(context.platform);
  const protection = await protectedPaths(context, await input.protectedWriteRoots(context.signal));
  const writes: string[] = [];
  const roots: string[] = [];
  const program = result.analysis?.commands?.[0]?.program;
  const rememberedPaths =
    kind === "command" && program
      ? (remembered ?? []).filter(
          (entry) => entry.folder === context.cwd && entry.program === program,
        )
      : [];
  for (const target of targets) {
    if (protection.covers(target.path)) return PROTECTED_PATH_REASON;
    const root =
      kind === "command" && target.exists
        ? target.path
        : await nearestExisting(
            kind === "command" ? target.path : api.dirname(target.path),
            context,
          );
    if (kind === "command" && protection.covers(root)) return PROTECTED_PATH_REASON;
    // Opening a folder that holds a reference folder would make the reference writable.
    if (
      kind === "command" &&
      input.boundary?.denyWriteRoots.some((denied) => containsPath(root, denied, context.platform))
    )
      return "readonly_workplace";
    if (!writes.includes(target.path)) writes.push(target.path);
    if (!roots.includes(root)) roots.push(root);
    // The card must name what really becomes writable when that is wider than the target.
    if (kind === "command" && root !== target.path)
      result.facts.push({ kind: "write", value: root });
  }
  result.outsideWrites = writes;
  result.outsideWriteRoots = roots;
  if (
    kind === "command" &&
    rememberedPaths.length &&
    writes.every((write) =>
      rememberedPaths.some(
        (entry) => write === entry.path || containsPath(entry.path, write, context.platform),
      ),
    )
  ) {
    // Only the outside-write card is skipped: levels, grants and every other check still decide.
    result.outsideWritesRemembered = true;
  }
  return undefined;
}
