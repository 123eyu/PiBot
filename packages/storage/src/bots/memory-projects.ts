import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** A project is one canonical working-folder path shared by every Bot and group. */
export class MemoryProjectsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Reads never create a project, so merely opening a folder leaves no row behind. */
  byPath(path: string): { id: string; path: string } | undefined {
    const row = this.db.prepare("SELECT id, path FROM memory_projects WHERE path = ?").get(path);
    return row ? { id: String(row.id), path: String(row.path) } : undefined;
  }

  byId(id: string): { id: string; path: string } | undefined {
    const row = this.db.prepare("SELECT id, path FROM memory_projects WHERE id = ?").get(id);
    return row ? { id: String(row.id), path: String(row.path) } : undefined;
  }

  ensure(path: string): { id: string; path: string } {
    this.db
      .prepare("INSERT OR IGNORE INTO memory_projects(id, path, created_at) VALUES (?, ?, ?)")
      .run(randomUUID(), path, new Date().toISOString());
    const row = this.byPath(path);
    if (!row) throw new TypeError("memory_project_unavailable");
    return row;
  }
}
