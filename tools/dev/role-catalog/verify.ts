// Verify catalog trust, archive integrity and team readability before publishing a catalog.
import { createHash, verify as verifySignature } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type RoleCatalogItem,
  RoleCatalogSchema,
} from "../../../packages/teams-contract/src/api/role-catalog.ts";
import { loadTeamArchive, safeArchivePath } from "./common.ts";

const directory = process.argv[2] ?? "role-catalog";
const publicKey = process.argv[3];
if (!publicKey) throw new Error("usage: role-catalog:verify <directory> <public-key.pem>");
// Both files are checked: 0.0.2 reads catalog.json, later apps catalog.v2.json; one bad file is
// enough to stop a publish.
const names = ["catalog.json", "catalog.v2.json"];
const catalogs = [];
for (const name of names) {
  const raw = await readFile(join(directory, name)).catch(() => undefined);
  if (!raw) {
    if (name === "catalog.json") throw new Error("catalog.json missing");
    continue;
  }
  const signature = await readFile(join(directory, `${name}.sig`));
  if (!verifySignature(null, raw, await readFile(publicKey), signature))
    throw new Error(`${name} signature invalid`);
  catalogs.push(RoleCatalogSchema.parse(JSON.parse(raw.toString())));
}
const catalog = catalogs[catalogs.length - 1] as (typeof catalogs)[number];
const { resolveTeam, zipEntries } = await loadTeamArchive();
async function check(item: RoleCatalogItem) {
  if (!safeArchivePath(item.archive)) throw new Error(`unsafe archive path: ${item.archive}`);
  const path = resolve(directory, item.archive);
  if (relative(resolve(directory), path).startsWith(".."))
    throw new Error(`archive escapes catalog: ${item.id}`);
  const info = await stat(path);
  const bytes = await readFile(path);
  if (!info.isFile()) throw new Error(`archive is not a file: ${item.id}`);
  if (bytes.length !== item.bytes) throw new Error(`archive size mismatch: ${item.id}`);
  if (createHash("sha256").update(bytes).digest("hex") !== item.sha256)
    throw new Error(`archive digest mismatch: ${item.id}`);
  const entries = zipEntries(bytes);
  resolveTeam(entries, "zh");
  resolveTeam(entries, "en");
}
for (const each of catalogs) for (const item of [...each.roles, ...each.groups]) await check(item);
console.log(`verified ${catalog.roles.length} roles and ${catalog.groups.length} groups`);
