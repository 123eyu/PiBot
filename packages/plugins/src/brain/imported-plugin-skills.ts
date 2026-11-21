import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PluginSkillInput } from "@pibot/brain/kit";
import { packagePath, scanSkillPackage } from "@pibot/brain/kit";
import { sameFile } from "@pibot/execution";
import {
  ClaudePluginSkillSchema,
  IdSchema,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  withProgressDeadline,
} from "@pibot/plugins-contract/full";
import { z } from "zod";

const descriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(4096),
  skills: z.array(ClaudePluginSkillSchema).max(100),
});
const MAX_FILES = SKILL_IMPORT_MAX_FILES;
const MAX_BYTES = SKILL_IMPORT_MAX_BYTES;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function safeRead(root: string, path: string, remaining: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!inside(root, path)) throw new Error("Invalid imported plugin resource path");
  let ancestor = path;
  while (ancestor !== root) {
    if ((await lstat(ancestor)).isSymbolicLink())
      throw new Error("Imported plugin links are invalid");
    ancestor = dirname(ancestor);
  }
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) > remaining)
    throw new Error("Invalid imported plugin resource");
  if (!inside(root, await realpath(path))) throw new Error("Imported plugin path escaped its root");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const statAfter = await file.stat({ bigint: true });
    if (!statAfter.isFile() || !sameFile(statAfter, stat) || statAfter.size !== stat.size)
      throw new Error("Imported resource changed");
    const content = await file.readFile({ signal });
    if (content.length > remaining) throw new Error("Imported plugin is too large");
    return content;
  } finally {
    await file.close();
  }
}

/** Loads only the reviewed skill paths copied by the import host; scripts stay inert resources. */
export async function loadImportedPluginSkills(
  dataDir: string,
  installationId: string,
  signal?: AbortSignal,
  onFailure?: (sourcePath: string) => void,
  activity?: () => void,
): Promise<(PluginSkillInput & { sourcePath: string })[]> {
  return withProgressDeadline(signal ?? new AbortController().signal, (signal, touch) =>
    loadWithProgress(dataDir, installationId, signal, onFailure, () => {
      touch();
      activity?.();
    }),
  );
}
async function loadWithProgress(
  dataDir: string,
  installationId: string,
  signal: AbortSignal,
  onFailure?: (sourcePath: string) => void,
  activity?: () => void,
): Promise<(PluginSkillInput & { sourcePath: string })[]> {
  signal?.throwIfAborted();
  const requestedRoot = join(dataDir, "plugins", IdSchema.parse(installationId));
  if (!(await lstat(requestedRoot)).isDirectory()) throw new Error("Invalid plugin root");
  const root = await realpath(requestedRoot);
  const descriptor = descriptorSchema.parse(
    JSON.parse(
      (await safeRead(root, join(root, ".pibot-plugin.json"), 1024 * 1024, signal)).toString(
        "utf8",
      ),
    ),
  );
  let files = 1;
  let bytes = 0;
  const result: (PluginSkillInput & { sourcePath: string })[] = [];
  for (const skill of descriptor.skills) {
    signal?.throwIfAborted();
    try {
      const relativePath = packagePath(skill.path);
      const source = resolve(root, ...relativePath.split("/"));
      if (!inside(root, source)) throw new Error("Imported skill escaped its root");
      if (skill.kind === "skill") {
        const scannedPackage = await scanSkillPackage(
          dirname(source),
          "folder",
          signal ?? new AbortController().signal,
          activity,
        );
        files += scannedPackage.summary.fileCount;
        bytes += scannedPackage.totalBytes;
        if (files > MAX_FILES || bytes > MAX_BYTES)
          throw new Error("Imported plugin exceeds limits");
        const locale = { skillMd: scannedPackage.skillText };
        result.push({
          sourcePath: relativePath,
          id: skill.id,
          scannedPackage,
          locales: { zh: locale, en: locale },
        });
        continue;
      }
      const original = await safeRead(
        root,
        source,
        Math.min(SKILL_IMPORT_FILE_MAX_BYTES, MAX_BYTES - bytes),
        signal,
      );
      bytes += original.length;
      files++;
      const resources: { path: string; content: Uint8Array }[] = [];
      if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("Imported plugin exceeds limits");
      const skillMd = `---\nname: ${skill.id}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${original.toString("utf8")}`;
      const locale = { skillMd, ...(resources.length ? { files: resources } : {}) };
      result.push({ sourcePath: relativePath, id: skill.id, locales: { zh: locale, en: locale } });
    } catch (error) {
      signal?.throwIfAborted();
      if (!onFailure) throw error;
      onFailure(skill.path);
    }
  }
  return result;
}
