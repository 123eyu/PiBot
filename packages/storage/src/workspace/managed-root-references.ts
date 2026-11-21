import { posix, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Stream all retained references; a first-page Bot registry is not a safe deletion check. */
export function actualRootReferences(
  db: DatabaseSync,
  path: string,
  platform: NodeJS.Platform,
  dataDir: string,
  managedSource?: string,
  /**
   * Maintainers 2026-11-14: a plan step's tree is Pi Bot's own metadata under its folder's `.pibot/wt`;
   * a workspace that merely contains that folder (a Bot's home project, say) does not retain it.
   */
  containersAllowed = false,
): boolean {
  const started = performance.now();
  let checked = 0;
  const saturated = () => ++checked > 100_000 || performance.now() - started > 100;
  const paths = platform === "win32" ? win32 : posix;
  const key = (value: string) => {
    const normal = paths.resolve(value);
    return platform === "linux" ? normal : normal.toLowerCase();
  };
  const target = key(path);
  const overlaps = (value: unknown, sourceReference = false) => {
    if (typeof value !== "string" || !paths.isAbsolute(value)) return false;
    const candidate = key(value);
    // A project-local tree is not retained just because its source remains a workspace.
    // Explicit tree/descendant references and frozen children still prevent cleanup.
    if (sourceReference && managedSource && candidate === key(managedSource)) return false;
    if (
      sourceReference &&
      containersAllowed &&
      managedSource &&
      key(managedSource).startsWith(candidate + paths.sep)
    )
      return false;
    return (
      candidate === target ||
      candidate.startsWith(target + paths.sep) ||
      target.startsWith(candidate + paths.sep)
    );
  };
  const sources = [
    `SELECT f.path FROM conversations c JOIN working_folders f ON f.bot_id=c.bot_id AND f.id=c.workplace_folder_id WHERE c.kind='dm'`,
    `SELECT f.path FROM topic_folders t JOIN working_folders f ON f.bot_id=t.bot_id AND f.id=t.folder_id`,
    `SELECT path FROM group_folders`,
    `SELECT json_extract(j.value,'$.path') AS path FROM group_topic_workspaces w
      JOIN conversations c ON c.id=w.conversation_id, json_each(w.folders) j
      WHERE NOT EXISTS(SELECT 1 FROM group_current_topics current WHERE current.conversation_id=c.id)`,
    `SELECT f.path FROM bot_workplace b JOIN working_folders f ON f.bot_id=b.bot_id AND f.id=b.current_folder_id`,
    `SELECT f.path FROM unattended_definition_folders d JOIN working_folders f
      ON f.bot_id=d.bot_id AND f.id=d.folder_id WHERE d.role IN ('primary','cwd','readonly')`,
  ];
  const protectedSources = [
    `SELECT path FROM unattended_watched_paths`,
    // Interrupted children can resume with frozen roots; final history is not a permanent lease.
    `SELECT json_extract(j.value,'$.canonicalPath') AS path FROM task_instances t,
      json_each(t.authority_json,'$.workplace.boundary.roots') j WHERE t.status IN ('queued','running','stopping','interrupted')`,
  ];
  for (const sql of sources)
    for (const row of db.prepare(sql).iterate())
      if (saturated() || overlaps(row.path, true)) return true;
  for (const sql of protectedSources)
    for (const row of db.prepare(sql).iterate()) if (saturated() || overlaps(row.path)) return true;
  // Home can be primary without a working_folders row (DM, group coordinator, routine or child).
  for (const row of db.prepare("SELECT id FROM bots").iterate())
    if (saturated() || overlaps(paths.join(dataDir, "bots", String(row.id), "home"))) return true;
  return false;
}
