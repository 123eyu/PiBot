import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { copyBundleLicenses } from "./licenses.ts";
import { resourceManifest } from "./manifest.ts";
import { runnerResourcesPlugin } from "./resource-plugin.ts";

export async function bundleRunner(
  repo: string,
  directory: string,
  temporary: string,
  version: string,
  fixture: boolean,
) {
  const buildEntry = async (entry: string, outfile: string, main: boolean, digest = "") => {
    await mkdir(dirname(outfile), { recursive: true });
    const result = await build({
      metafile: true,
      absWorkingDir: repo,
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: main ? "esm" : "cjs",
      target: "node26",
      sourcemap: false,
      legalComments: "eof",
      minify: true,
      treeShaking: true,
      define: {
        __PIBOT_RUNNER_VERSION__: JSON.stringify(version),
        __PIBOT_RUNNER_RESOURCES_SHA256__: JSON.stringify(digest),
        __PIBOT_RUNNER_FIXTURE__: JSON.stringify(fixture),
        ...(!main ? { "import.meta.url": "__pibotImportUrl" } : {}),
      },
      banner: {
        js: main
          ? 'import { createRequire as __pibotRequire, isBuiltin as __pibotBuiltin } from "node:module"; const __pibotNodeRequire = __pibotRequire(import.meta.url); const require = (id) => { if (!__pibotBuiltin(id)) throw new Error("runner_external_module_unavailable"); return __pibotNodeRequire(id); };'
          : 'const __pibotImportUrl = require("node:url").pathToFileURL(__filename).href;',
      },
      plugins: [runnerResourcesPlugin(main)],
    });
    await copyBundleLicenses(repo, join(directory, "resources"), result.metafile);
  };
  const main = join(temporary, "runner.mjs");
  const entries = join(directory, "resources", "entry");
  for (const [name, entry] of [
    ["sandbox-host", "packages/execution/src/sandbox/sandbox-host.ts"],
    ["violation-log", "packages/execution/src/sandbox/violation-log.ts"],
    ["uninstall-credentials", "apps/runner/installer/windows/uninstall-credentials.mjs"],
    ...(fixture ? [["runner-fixture", "apps/runner/src/fixture.ts"]] : []),
  ])
    await buildEntry(entry as string, join(entries, `${name}.cjs`), false);
  await writeFile(
    join(directory, "resources", "package.json"),
    '{"private":true,"type":"commonjs"}\n',
  );
  await buildEntry("apps/runner/src/sea.ts", main, true);
  const digest = createHash("sha256")
    .update(JSON.stringify(await resourceManifest(directory)))
    .digest("hex");
  await buildEntry("apps/runner/src/sea.ts", main, true, digest);
  return { main };
}
