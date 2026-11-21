import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Attachment files are stored relative to the data directory (`bots/<botId>/attachments/<file>`,
 * always `/`-separated) so a moved, restored or differently spelled data directory keeps chat
 * attachments and generated images readable. Same scheme as session files.
 */
const STORED = /^bots\/([^/\\\0\r\n]+)\/attachments\/([^/\\\0\r\n]+)$/;

function parts(stored: string): { botId: string; file: string } | undefined {
  const match = STORED.exec(stored);
  if (!match || stored.split("/").some((part) => part === "." || part === "..")) return undefined;
  return { botId: match[1] as string, file: match[2] as string };
}

/** Whether a value is in the stored (relative) form, optionally for one owning Bot. */
export function isStoredAttachmentPath(stored: string, botId?: string): boolean {
  const parsed = parts(stored);
  return !!parsed && (botId === undefined || parsed.botId === botId);
}

/**
 * The stored form of an attachment file in this data directory. `dataDir` must be spelled the
 * same way as the directory the file was built from (callers use the realpath'd data root).
 */
export function storedAttachmentPath(dataDir: string, file: string): string {
  const path = relative(dataDir, file).split(sep).join("/");
  if (!parts(path)) throw new TypeError("Invalid attachment path");
  return path;
}

/**
 * The absolute file for a stored value. Relative values are joined to this data directory;
 * absolute values are legacy rows the migration could not recognise and are returned unchanged
 * so the caller's own containment check (must be inside this Bot's attachments folder) decides.
 */
export function resolveAttachmentPath(dataDir: string, stored: string): string {
  if (isAbsolute(stored)) return stored;
  const parsed = parts(stored);
  if (!parsed) throw new TypeError("Invalid attachment path");
  return join(dataDir, "bots", parsed.botId, "attachments", parsed.file);
}
