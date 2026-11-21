import { cp, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Copy a target deployment's closed native graph, never binaries resolved from the build host. */
export async function copyRunnerComputerAssets(options: {
  dependencyRoot: string;
  resourcesDir: string;
  platform: "darwin" | "win32" | "linux";
  arch: "x64" | "arm64";
}) {
  const suffix =
    options.platform === "linux" ? "-gnu" : options.platform === "win32" ? "-msvc" : "";
  const target = `${options.platform}-${options.arch}${suffix}`;
  const names = [
    "@trycua/cua-driver",
    `@trycua/cua-driver-${target}`,
    "@ubjs/core",
    "@ubjs/node",
    `@ubjs/node-${target}`,
    "@napi-rs/image",
    `@napi-rs/image-${target}`,
  ];
  const root = await realpath(resolve(options.dependencyRoot));
  const destination = join(options.resourcesDir, "computer", "node_modules");
  await mkdir(destination, { recursive: true });
  const reports: { name: string; version: string; license: string; bytes: number }[] = [];
  const driver = await packageDirectory(root, "@trycua/cua-driver", root);
  for (const name of names) {
    // Platform packages may sit under the driver's own node_modules when not hoisted.
    const found =
      (await packageDirectory(root, name, root).catch(() => undefined)) ??
      (await packageDirectory(driver, name, root));
    const directory = await realpath(found);
    if (!directory.startsWith(`${root}${sep}`))
      throw new Error("runner_computer_resource_outside_deployment");
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const expected = name.startsWith("@trycua/")
      ? "0.38.0"
      : name.startsWith("@ubjs/")
        ? "0.31.0-3"
        : "1.16.0";
    if (manifest.version !== expected) throw new Error("runner_computer_resource_version");
    reports.push({
      name,
      version: expected,
      license: String(manifest.license ?? "see-package-notices"),
      bytes: await packageBytes(directory),
    });
    // Version and target loaders remain beside their own .node/.dylib/.dll; no workspace symlinks.
    await cp(directory, join(destination, ...name.split("/")), {
      recursive: true,
      dereference: true,
    });
  }
  return reports;
}

/**
 * Node's node_modules walk without `exports`: @trycua/cua-driver is ESM-only and exports neither
 * a require entry nor ./package.json, so require.resolve cannot locate its folder.
 */
async function packageDirectory(from: string, name: string, root: string): Promise<string> {
  let directory = from;
  while (directory.startsWith(root)) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      if (manifest.name === name) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("runner_computer_resource_missing");
}

async function packageBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("runner_computer_resource_symlink");
    if (info.isDirectory()) bytes += await packageBytes(path);
    else if (info.isFile()) bytes += info.size;
    else throw new Error("runner_computer_resource_not_regular");
  }
  return bytes;
}
