import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  fetchOpenRouterCatalog,
} from "./openrouter-catalog.ts";

export function createModelCatalogCache(dataDir: string) {
  const directory = join(dataDir, "model-catalogs");
  const path = join(directory, "openrouter.json");
  let snapshot: CatalogSnapshot | undefined;
  let loading: Promise<void> | undefined;
  let refreshing:
    | Promise<{ providerId: "openrouter"; count: number; updatedAt: string }>
    | undefined;
  const load = () =>
    (loading ??= (async () => {
      try {
        if (!(await lstat(directory)).isDirectory()) return;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return;
        snapshot = CatalogSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        // Metadata is disposable: missing, unreadable or corrupt cache falls back to the bundled catalog.
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof Error && error.name === "ZodError") &&
          !["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    })());
  return {
    async get() {
      await load();
      return snapshot;
    },
    refresh(signal: AbortSignal) {
      if (refreshing) return refreshing;
      const work = async () => {
        await load();
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        const next = await fetchOpenRouterCatalog(deadline);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid catalog directory");
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(next), {
            mode: 0o600,
            flag: "wx",
            signal: deadline,
          });
          deadline.throwIfAborted();
          await rename(temporary, path);
          // Publish only after atomic replacement. Existing sessions retain their old runtime.
          snapshot = next;
        } finally {
          await rm(temporary, { force: true });
        }
        return {
          providerId: "openrouter" as const,
          count: next.models.length,
          updatedAt: next.updatedAt,
        };
      };
      refreshing = work().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
}
