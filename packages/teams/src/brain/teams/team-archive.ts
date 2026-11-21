import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  importedDocument,
  junkPath,
  PackageError,
  type PackageFile,
  packagePath,
  parseSkillFile,
  type RawEntry,
  readZip,
  renderSkillFile,
  scriptLike,
  textOf,
  writeZip,
} from "@pibot/brain/kit";
import {
  localizeTeamJson,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  TEAM_ARCHIVE_MAX_BYTES,
  TEAM_ARCHIVE_MAX_FILES,
  TEAM_V3_JSON_MAX_BYTES,
  type TeamSkillReimport,
  type TeamTemplate,
  TeamTemplateSchema,
} from "@pibot/protocol";

/**
 * `.pibot` version 3 has two equivalent forms with the same contents:
 * a zip (what users export and import) and an unpacked `<id>.pibot/` folder (how built-ins are
 * kept in the repository). Both become the same entry list, and one reader handles it:
 * `team.json` at the top, each skill as a package folder `skills/<ref>/<folder>/` holding
 * SKILL.md plus scripts/references, or `zh/` and `en/` variants of that for built-ins.
 */
export const TEAM_JSON = "team.json";
const ZIP_MAGIC = 0x04034b50;
export function isTeamArchive(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === ZIP_MAGIC;
}

export function zipEntries(data: Buffer): RawEntry[] {
  if (data.length > TEAM_ARCHIVE_MAX_BYTES) throw new PackageError("too_large");
  return readZip(data, {
    maxTotal: TEAM_ARCHIVE_MAX_BYTES,
    maxFiles: TEAM_ARCHIVE_MAX_FILES,
    maxFile: Math.max(SKILL_IMPORT_FILE_MAX_BYTES, TEAM_V3_JSON_MAX_BYTES),
    skip: junkPath,
  });
}

/**
 * The unpacked form. Only `readdir` / `readFile` / `lstat` (a packaged app keeps built-ins inside
 * app.asar, where these are what works); links and special files are refused like in a zip.
 */
export async function folderEntries(root: string): Promise<RawEntry[]> {
  const entries: RawEntry[] = [];
  let total = 0;
  const walk = async (path: string, parts: string[]) => {
    if (parts.length >= 16) throw new PackageError("unsafe");
    for (const name of (await readdir(path)).sort()) {
      const absolute = join(path, name);
      const relative = [...parts, name].join("/");
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new PackageError("unsafe");
      if (stat.isDirectory()) {
        await walk(absolute, [...parts, name]);
        continue;
      }
      if (!stat.isFile()) throw new PackageError("unsafe");
      if (junkPath(relative)) continue;
      if (stat.size > Math.max(SKILL_IMPORT_FILE_MAX_BYTES, TEAM_V3_JSON_MAX_BYTES))
        throw new PackageError("too_large");
      total += stat.size;
      if (total > TEAM_ARCHIVE_MAX_BYTES) throw new PackageError("too_large");
      if (entries.length >= TEAM_ARCHIVE_MAX_FILES) throw new PackageError("too_many_files");
      entries.push({ path: relative, data: await readFile(absolute) });
    }
  };
  await walk(root, []);
  return entries;
}

/** The raw team.json of a version-3 entry list, still with `{zh, en}` text where given. */
export function teamJson(entries: readonly RawEntry[]): unknown {
  const json = entries.find((entry) => entry.path === TEAM_JSON);
  const text = json && textOf(json.data);
  if (!text || Buffer.byteLength(text) > TEAM_V3_JSON_MAX_BYTES) throw new PackageError("no_team");
  try {
    return JSON.parse(text);
  } catch {
    throw new PackageError("no_team");
  }
}

/** One Bot's skill, ready for `SkillService.create(…, { enabled, files })`. */
export interface TeamSkillPackage {
  folder: string;
  enabled: boolean;
  document: ReturnType<typeof importedDocument>;
  files: PackageFile[];
  reimport?: TeamSkillReimport["reimport"];
}
export interface ResolvedTeam {
  /** Plain-text template in one language; skills inline (with `folder`) for the preview. */
  template: TeamTemplate;
  /** Skill packages per Bot, in template order. */
  skills: TeamSkillPackage[][];
  /** Entries that belong to no skill of the template; they are not imported. */
  skipped: number;
}

/**
 * Reads one version-3 entry list in one language with the safety rules of a skill package
 * import: Windows-safe names, no case-only duplicates, per-skill size and count limits. A
 * built-in's other-language variant is part of the package, not a skipped file.
 */
export function resolveTeam(entries: readonly RawEntry[], language: "zh" | "en"): ResolvedTeam {
  const seen = new Set<string>();
  const byPath = new Map<string, Buffer>();
  for (const entry of entries) {
    const path = packagePath(entry.path);
    if (seen.has(path.toLowerCase())) throw new PackageError("unsafe");
    seen.add(path.toLowerCase());
    byPath.set(path, entry.data);
  }
  const raw = TeamTemplateSchema.parse(localizeTeamJson(teamJson(entries), language));
  if (raw.version !== 3) throw new PackageError("no_team");
  const used = new Set<string>([TEAM_JSON]);
  const skills: TeamSkillPackage[][] = [];
  const bots = raw.bots.map((bot) => {
    const packages: TeamSkillPackage[] = [];
    const notices: TeamSkillReimport[] = [];
    for (const skill of bot.skills ?? []) {
      // Version 3 files name the folder only; an inline skill (v2 style) is not a package.
      if (!skill.folder || "body" in skill) throw new PackageError("no_team");
      if ("reimport" in skill) {
        notices.push(skill);
        continue;
      }
      const base = `skills/${bot.ref}/${skill.folder}/`;
      for (const path of byPath.keys()) if (path.startsWith(base)) used.add(path);
      const root = byPath.has(`${base}SKILL.md`) ? base : `${base}${language}/`;
      const text = textOf(byPath.get(`${root}SKILL.md`) ?? Buffer.alloc(0));
      if (!text) throw new PackageError("no_skill");
      const files: PackageFile[] = [];
      let bytes = 0;
      for (const [path, data] of byPath) {
        if (!path.startsWith(root) || path === `${root}SKILL.md`) continue;
        const inside = path.slice(root.length);
        files.push({
          path: inside,
          data,
          text: textOf(data) !== undefined,
          script: scriptLike(inside, data),
        });
        bytes += data.length;
      }
      if (files.length > SKILL_IMPORT_MAX_FILES) throw new PackageError("too_many_files");
      if (bytes > SKILL_IMPORT_MAX_BYTES) throw new PackageError("too_large");
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      packages.push({
        folder: skill.folder,
        enabled: skill.enabled,
        document: importedDocument(parseSkillFile(text), skill.folder),
        files,
      });
    }
    skills.push(packages);
    return packages.length || notices.length
      ? {
          ...bot,
          skills: [
            ...packages.map((p) => ({ ...p.document, enabled: p.enabled, folder: p.folder })),
            ...notices,
          ],
        }
      : { ...bot, skills: undefined };
  });
  const template = TeamTemplateSchema.parse({
    ...raw,
    bots: bots.map(({ skills: list, ...bot }) => (list ? { ...bot, skills: list } : bot)),
  });
  return { template, skills, skipped: [...byPath.keys()].filter((p) => !used.has(p)).length };
}

/**
 * Writes a version-3 zip (a user export: one language). team.json names each skill folder;
 * the folder holds the rendered SKILL.md and the supporting files.
 */
export function buildTeamArchive(
  template: TeamTemplate,
  skills: readonly (readonly TeamSkillPackage[])[],
): Buffer {
  const entries: { path: string; data: Buffer }[] = [
    { path: TEAM_JSON, data: Buffer.from(`${JSON.stringify(template, null, 2)}\n`) },
  ];
  template.bots.forEach((bot, index) => {
    for (const skill of skills[index] ?? []) {
      if (skill.reimport) continue;
      const base = `skills/${bot.ref}/${skill.folder}`;
      entries.push({
        path: `${base}/SKILL.md`,
        data: Buffer.from(renderSkillFile(skill.folder, skill.document)),
      });
      for (const file of skill.files)
        entries.push({ path: `${base}/${file.path}`, data: file.data });
    }
  });
  if (entries.length > TEAM_ARCHIVE_MAX_FILES) throw new PackageError("too_many_files");
  if (entries.reduce((sum, entry) => sum + entry.data.length, 0) > TEAM_ARCHIVE_MAX_BYTES)
    throw new PackageError("too_large");
  const archive = writeZip(entries);
  if (archive.length > TEAM_ARCHIVE_MAX_BYTES) throw new PackageError("too_large");
  return archive;
}
