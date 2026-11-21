import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 230 MB (maintainers 2026-11-12, was 140): runner computer use ships in the package rather than being
 * downloaded on demand; its native drivers and image codec add 58-82 MB per platform on top of
 * the ~113 MB Node runtime.
 */
const BUDGET = 230_000_000;

export async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal: AbortSignal.timeout(60_000) }))
    hash.update(chunk);
  return { bytes: (await stat(path)).size, sha256: hash.digest("hex") };
}

export type ResourceEntries = Awaited<ReturnType<typeof resourceManifest>>;

export async function resourceManifest(directory: string) {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  const walk = async (parts: string[]) => {
    for (const entry of await readdir(join(directory, ...parts), { withFileTypes: true })) {
      const path = [...parts, entry.name];
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        entries.push({ path: path.join("/"), ...(await fileDigest(join(directory, ...path))) });
      else throw new Error("runner_resource_type");
    }
  };
  await walk(["resources"]);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `resources`: a list taken before the macOS .app was assembled (the runtime check reads it next
 * to Contents/MacOS/runner-core, as resources/... through the bundle's resources link).
 */
export async function writeRunnerManifest(
  directory: string,
  metadata: Record<string, unknown>,
  resources?: ResourceEntries,
) {
  resources ??= await resourceManifest(directory);
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify({ version: 2, ...metadata, resources }, null, 2)}\n`,
  );
  let bytes = 0;
  const count = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await count(next);
      else bytes += (await stat(next)).size;
    }
  };
  await count(directory);
  process.stdout.write(
    `runner unpacked: ${bytes} bytes (${(bytes / 1_000_000).toFixed(2)} MB); budget: ${BUDGET} bytes\n`,
  );
  if (bytes > BUDGET) throw new Error("runner_size_budget_exceeded");
}
