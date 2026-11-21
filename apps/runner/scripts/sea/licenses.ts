import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Metafile } from "esbuild";

/** Bundled code loses package directories; retain its published license notices alongside assets. */
export async function copyBundleLicenses(repo: string, resources: string, graph: Metafile) {
  const visited = new Set<string>();
  for (const input of Object.keys(graph.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(isAbsolute(input) ? input : resolve(repo, input));
    while (directory !== dirname(directory)) {
      let pkg: { name: string; version: string };
      try {
        pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directory = dirname(directory);
        continue;
      }
      const key = `${pkg.name}@${pkg.version}`.replace(/[^a-z0-9@._-]/gi, "_");
      if (visited.has(key)) break;
      visited.add(key);
      const destination = join(resources, "licenses", key);
      await mkdir(destination, { recursive: true });
      await cp(join(directory, "package.json"), join(destination, "package.json"));
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && /^(?:licen[cs]e|notice|third.party)/i.test(file.name))
          await cp(join(directory, file.name), join(destination, file.name));
      }
      break;
    }
  }
}
