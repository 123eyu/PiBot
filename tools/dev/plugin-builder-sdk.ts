import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Resolve the workspace link by package name so SDK relocation does not affect this build. */
export function copyPluginBuilderSdk(root: string, builtin: string): void {
  const require = createRequire(join(root, "packages/plugins/package.json"));
  let sdk = dirname(realpathSync(require.resolve("@pibot/plugin-sdk")));
  while (!existsSync(join(sdk, "package.json"))) {
    const parent = dirname(sdk);
    if (parent === sdk) throw new Error("plugin_builder_sdk_package_missing");
    sdk = parent;
  }
  const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  if (manifest.name !== "@pibot/plugin-sdk" || !manifest.scripts?.pack)
    throw new Error("plugin_builder_sdk_pack_missing");
  // The SDK owns bundling and its application version. Never copy workspace source as a fallback.
  execFileSync("pnpm", ["--dir", sdk, "run", "pack"], {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
  });
  // The SDK's pack script writes into dist/; a plain `pnpm pack` writes beside package.json.
  const wanted = `pibot-plugin-sdk-${manifest.version}.tgz`;
  const folder = [join(sdk, "dist"), sdk].find((dir) => existsSync(join(dir, wanted)));
  if (!folder) throw new Error("plugin_builder_sdk_archive_missing");
  const archive = join(folder, wanted);
  for (const language of ["zh", "en"]) {
    const destination = join(
      builtin,
      "roles/plugin-builder.pibot/skills/plugin-builder/plugin-building",
      language,
      "sdk",
    );
    mkdirSync(destination, { recursive: true });
    cpSync(archive, join(destination, "pibot-plugin-sdk.tgz"));
    cpSync(join(sdk, "README.md"), join(destination, "README.md"));
  }
}
