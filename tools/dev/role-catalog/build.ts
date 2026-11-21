// Build immutable role and group archives plus the signed-catalog input for T2.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archivePath,
  builtin,
  ensureDir,
  loadTeamArchive,
  type RawEntry,
  readJson,
  root,
  sha256,
} from "./common.ts";

type Team = {
  bots: Array<{
    name: Localized;
    description?: Localized;
    category?: string;
    avatarShape?: string;
    avatarColor?: string;
    avatarEyes?: string;
    role?: Meta;
  }>;
  groups: Array<{ name: Localized; summary?: Localized; members?: string[]; template?: Meta }>;
};
type Localized = { zh: string; en: string };
type Meta = { id: string; version: number; name: Localized; category?: string };
const output = process.argv[2] ?? join(root, "role-catalog");
async function buildItem(
  kind: "roles" | "groups",
  directory: string,
  writeZip: (entries: readonly RawEntry[]) => Buffer,
) {
  const team = await readJson<Team>(join(directory, "team.json"));
  const bot = kind === "roles" ? team.bots[0] : undefined;
  const group = kind === "groups" ? team.groups[0] : undefined;
  const source = bot ?? group;
  const meta = bot?.role ?? group?.template;
  if (!source || !meta) throw new Error(`missing metadata in ${directory}`);
  const entries = await (await loadTeamArchive()).folderEntries(directory);
  const archive = archivePath(kind, meta.id, meta.version);
  const path = join(output, archive);
  await ensureDir(join(path, ".."));
  await writeFile(path, writeZip(entries));
  const description = bot ? bot.description : group?.summary;
  const item = {
    id: meta.id,
    version: meta.version,
    name: source.name,
    description: description ?? source.name,
    category: meta.category ?? bot?.category ?? "group",
    archive,
    sha256: await sha256(path),
    bytes: (await stat(path)).size,
  };
  return {
    ...item,
    title: meta.name,
    summary: description ?? source.name,
    ...(bot
      ? {
          avatar: {
            shape: bot.avatarShape ?? "blob",
            color: bot.avatarColor ?? "gray",
            eyes: bot.avatarEyes ?? "marks",
          },
          defaultBotName: bot.name,
        }
      : { members: group?.members ?? [] }),
  };
}
const { writeZip } = await loadTeamArchive();
await ensureDir(output);
const catalog = {
  format: 1 as const,
  generatedAt: new Date().toISOString(),
  minApp: "0.0.1",
  roles: [] as Awaited<ReturnType<typeof buildItem>>[],
  groups: [] as Awaited<ReturnType<typeof buildItem>>[],
  history: await readJson(join(builtin, "history.json")),
  professions: JSON.parse(await readFile(join(builtin, "professions.json"), "utf8")),
};
for (const kind of ["roles", "groups"] as const)
  for (const name of (await readdir(join(builtin, kind)))
    .filter((item) => item.endsWith(".pibot"))
    .sort())
    catalog[kind].push(await buildItem(kind, join(builtin, kind, name), writeZip));
await writeFile(join(output, "catalog.v2.json"), `${JSON.stringify(catalog, null, 2)}\n`);
// 0.0.2 parses catalog.json strictly: it keeps exactly the v1 fields, in the same order.
const V2_ONLY = new Set(["title", "summary", "avatar", "defaultBotName", "members"]);
const v1Item = (item: object) =>
  Object.fromEntries(Object.entries(item).filter(([key]) => !V2_ONLY.has(key)));
const v1 = { ...catalog, roles: catalog.roles.map(v1Item), groups: catalog.groups.map(v1Item) };
await writeFile(join(output, "catalog.json"), `${JSON.stringify(v1, null, 2)}\n`);
