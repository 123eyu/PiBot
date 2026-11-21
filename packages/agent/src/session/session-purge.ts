import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { REFERENCE_TYPE, referenceDetails } from "../extensions/transcript-entries.ts";

/** Custom type of the placeholder that replaces a purged reference entry. */
export const REMOVED_REFERENCE_TYPE = "pibot_reference_removed";
const PLACEHOLDER =
  "[已删除的群参考资料 / Group reference removed: its content was deleted or is no longer available to this Bot.]";

/** Which saved references to remove: all of them, or those that showed one of these messages. */
export type ReferenceMatch = { all: true } | { messageIds: ReadonlySet<string> };

const MAX_LINE = 2_000_000;

/**
 * Saved group references are kept, but purged on delete. Replaces every matching saved entry
 * with a fixed placeholder: same entry id, parent and position, no content, no message
 * ids. Order and the entry tree stay intact, so the session still loads and later runs simply see
 * no reference there (they build a fresh one; one prompt-cache miss for that session).
 *
 * The file is rewritten to a temporary sibling and renamed over the original, so a crash leaves
 * either the old or the new file, never a half-written one; pi appends by path, so a later
 * append lands in the new file. Idempotent: placeholders never match again. Lines that are not
 * JSON are kept as they are. Returns the number of entries replaced (0 when the file is gone).
 */
export async function purgeSessionReferences(
  file: string,
  match: ReferenceMatch,
  signal: AbortSignal,
): Promise<number> {
  // A run appending to this session between our read and the rename would lose that append, so
  // the rename only happens while the file is still the one we read; otherwise start over.
  for (let attempt = 0; attempt < 5; attempt++) {
    const replaced = await rewriteOnce(file, match, signal);
    if (replaced !== "changed") return replaced;
  }
  throw new Error("Session file kept changing during purge");
}

async function rewriteOnce(
  file: string,
  match: ReferenceMatch,
  signal: AbortSignal,
): Promise<number | "changed"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  signal.throwIfAborted();
  let replaced = 0;
  const lines = text.split("\n").map((line) => {
    if (!line || line.length > MAX_LINE || !line.includes(REFERENCE_TYPE)) return line;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      // Not a session entry we can read; leaving it is what pi's own loader does too.
      return line;
    }
    if (entry.type !== "custom_message" || entry.customType !== REFERENCE_TYPE) return line;
    if (!matches(entry.details, match)) return line;
    replaced++;
    return JSON.stringify({
      type: "custom_message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: REMOVED_REFERENCE_TYPE,
      content: [{ type: "text", text: PLACEHOLDER }],
      display: false,
      details: { v: 1 },
    });
  });
  if (!replaced) return 0;
  signal.throwIfAborted();
  const temporary = `${file}.purge-${randomUUID()}`;
  try {
    await writeFile(temporary, lines.join("\n"), { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    if ((await stat(file)).size !== Buffer.byteLength(text)) {
      await rm(temporary, { force: true });
      return "changed";
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return replaced;
}

function matches(details: unknown, match: ReferenceMatch) {
  if ("all" in match) return true;
  const parsed = referenceDetails.safeParse(details);
  // A reference whose details cannot be read may show anything: remove it.
  if (!parsed.success) return true;
  return Object.keys(parsed.data.known.messages).some((id) => match.messageIds.has(id));
}
