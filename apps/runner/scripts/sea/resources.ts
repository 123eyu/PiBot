import { access, cp, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Target } from "./types.ts";
import { copyVcruntime } from "./vcruntime.ts";

async function packageDirectory(from: string, name: string) {
  const require = createRequire(join(from, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let directory = dirname(require.resolve(name));
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === name) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error("runner_resource_package_missing");
}

/** Follow each package's real dependency resolution, preserving nested versions instead of copying the root's version. */
export async function copyRuntimeResources(
  deployedPath: string,
  resources: string,
  target: Target,
) {
  // macOS temp dirs live under /var, a link to /private/var; module resolution returns the real
  // path, so the deploy root must be real too or every package looks outside it.
  const deployed = await realpath(deployedPath);
  const pending = await Promise.all(
    ["@anthropic-ai/sandbox-runtime", "node-datachannel", "@napi-rs/keyring"].map((name) =>
      packageDirectory(deployed, name),
    ),
  );
  const visited = new Set<string>(),
    packages = new Set<string>();
  const targetSuffix = `${target.platform}-${target.arch}${target.platform === "linux" ? "-gnu" : target.platform === "win32" ? "-msvc" : ""}`;
  while (pending.length) {
    const source = pending.shift() as string;
    if (visited.has(source)) continue;
    visited.add(source);
    const layout = relative(join(deployed, "node_modules"), source);
    if (isAbsolute(layout) || layout.split(/[\\/]/).includes(".."))
      throw new Error("runner_resource_outside_deploy");
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    packages.add(`${manifest.name}@${manifest.version}`);
    const destination = join(resources, "node_modules", layout);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const parts = relative(source, path).split(/[\\/]/);
        if (
          parts[0] === "node_modules" ||
          /\.(?:[cm]?ts|map)$/.test(path) ||
          parts.some((part) => ["test", "tests", "__tests__", "docs", ".github"].includes(part))
        )
          return false;
        if (manifest.name === "@anthropic-ai/sandbox-runtime" && parts[0] === "vendor") {
          if (
            parts[1] === "seccomp" &&
            (target.platform !== "linux" || (parts[2] && parts[2] !== target.arch))
          )
            return false;
          if (
            parts[1] === "srt-win" &&
            (target.platform !== "win32" || (parts[2] && parts[2] !== target.arch))
          )
            return false;
        }
        return true;
      },
    });
    for (const name of Object.keys(manifest.dependencies ?? {}))
      pending.push(await packageDirectory(source, name));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      if (
        name !== `@node-datachannel/${targetSuffix}` &&
        name !== `@napi-rs/keyring-${targetSuffix}`
      )
        continue;
      try {
        pending.push(await packageDirectory(source, name));
      } catch (error) {
        if (
          name.startsWith("@node-datachannel/") &&
          (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
        )
          continue;
        throw error;
      }
    }
  }
  if (target.platform === "win32")
    await copyVcruntime(
      join(resources, "node_modules", "@napi-rs", `keyring-win32-${target.arch}-msvc`),
    );
  // The runner's command analyzer loads the same parser as the desktop from resources/wasm.
  await mkdir(join(resources, "wasm"), { recursive: true });
  const policy = await packageDirectory(deployed, "@pibot/policy");
  for (const [name, file] of [
    ["web-tree-sitter", "web-tree-sitter.wasm"],
    ["tree-sitter-bash", "tree-sitter-bash.wasm"],
  ] as const)
    await cp(join(await packageDirectory(policy, name), file), join(resources, "wasm", file));
  const rgRoot = await packageDirectory(
    deployed,
    `@vscode/ripgrep-${target.platform}-${target.arch}`,
  );
  await mkdir(join(resources, "bin"), { recursive: true });
  const rg = target.platform === "win32" ? "rg.exe" : "rg";
  await access(join(rgRoot, "bin", rg));
  await cp(join(rgRoot, "bin", rg), join(resources, "bin", rg));
  await cp(join(rgRoot, "LICENSE"), join(resources, "bin", "RIPGREP-LICENSE"));
  return { externalPackages: [...packages].sort() };
}
