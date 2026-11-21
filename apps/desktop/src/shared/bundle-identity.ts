import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Generated from every emitted JS chunk, including shared and dynamically loaded code. */
export async function bundleIdentity(entry: string, version: string): Promise<string> {
  const directory = dirname(fileURLToPath(entry));
  let hash: string;
  try {
    hash = (await readFile(join(directory, "startup-bundle.sha256"), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_bundle_hash");
  } catch {
    // Older development outputs have no manifest. A same-version replacement must still differ.
    const digest = createHash("sha256");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".js")).sort();
    for (const name of names) {
      digest.update(name);
      digest.update(await readFile(join(directory, name)));
    }
    if (!names.length) digest.update(await readFile(fileURLToPath(entry)));
    hash = digest.digest("hex");
  }
  return createHash("sha256").update(version).update(hash).digest("hex");
}

/** Never follow a cache root or entry symlink, nor remove anything not created by this scheme. */
export async function pruneCompileCache(root: string, current: string): Promise<boolean> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.slice(0, 64)) {
      if (entry.name === current || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}
