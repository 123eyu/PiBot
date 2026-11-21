// Shared filesystem, archive and catalog helpers keep build and verify deterministic and bounded.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A file inside a .pibot archive, as team-archive.ts reads and writes it. */
export type RawEntry = { path: string; data: Buffer };

export const root = fileURLToPath(new URL("../../../", import.meta.url));
// The published library is built from a pibot-roles checkout (the full catalog); the
// repository's packages/teams/builtin holds only the offline starter set.
export const builtin = process.env.PIBOT_ROLE_CATALOG_SOURCE ?? join(root, "../pibot-roles");
export const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;
export const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export const ensureDir = (path: string) => mkdir(path, { recursive: true });
export async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...(await listFiles(path)));
    else result.push(path);
  }
  return result;
}
interface ArchiveModule {
  folderEntries: (path: string) => Promise<RawEntry[]>;
  resolveTeam: (entries: readonly RawEntry[], language: "zh" | "en") => unknown;
  zipEntries: (data: Buffer) => RawEntry[];
}

export async function loadTeamArchive(): Promise<{
  folderEntries: (path: string) => Promise<RawEntry[]>;
  writeZip: (entries: readonly RawEntry[]) => Buffer;
  resolveTeam: (entries: readonly RawEntry[], language: "zh" | "en") => unknown;
  zipEntries: (data: Buffer) => RawEntry[];
}> {
  const desktop = createRequire(join(root, "apps/desktop/package.json"));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const loader = vite("jiti").createJiti(import.meta.url, { fsCache: false });
  const archive = (await loader.import(
    join(root, "packages/teams/src/brain/teams/team-archive.ts"),
  )) as ArchiveModule;
  const brain = (await loader.import(join(root, "packages/brain/src/core/zip-write.ts"))) as {
    writeZip: (entries: readonly RawEntry[]) => Buffer;
  };
  return {
    folderEntries: archive.folderEntries,
    resolveTeam: archive.resolveTeam,
    zipEntries: archive.zipEntries,
    writeZip: brain.writeZip,
  };
}
export function archivePath(kind: "roles" | "groups", id: string, version: number) {
  return `${kind}/${id}.v${version}.pibot`;
}
export function safeArchivePath(path: string): boolean {
  return (
    path === path.replaceAll("\\", "/") &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    /^(roles|groups)\/[a-z0-9][a-z0-9-]*\.v[1-9][0-9]*\.pibot$/.test(path)
  );
}
