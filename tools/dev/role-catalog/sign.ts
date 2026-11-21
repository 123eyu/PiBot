// Sign the exact catalog bytes; the private key is supplied only through the environment.
import { sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const directory = process.argv[2] ?? "role-catalog";
const keyPath = process.env.PIBOT_ROLE_CATALOG_KEY;
if (!keyPath) throw new Error("PIBOT_ROLE_CATALOG_KEY is required");
const key = await readFile(keyPath);
for (const name of ["catalog.json", "catalog.v2.json"]) {
  const catalog = await readFile(`${directory}/${name}`);
  await writeFile(`${directory}/${name}.sig`, sign(null, catalog, key));
}
