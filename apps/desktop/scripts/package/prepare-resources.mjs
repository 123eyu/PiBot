import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { prepareCuaDaemon } from "./prepare-cua-daemon.mjs";
import { prepareMinGit } from "./prepare-mingit.mjs";
import { prepareNodeHelper } from "./prepare-node-helper.mjs";

/** @param {import("app-builder-lib").BeforePackContext} context */
export default async function prepareM1Resources(context) {
  const desktop = context.packager.projectDir;
  const execRequire = createRequire(join(desktop, "../../packages/execution/package.json"));
  const policyRequire = createRequire(join(desktop, "../../packages/policy/package.json"));
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  if (!arch || arch === "universal")
    throw new Error("Resources require a single target architecture (x64 or arm64 on macOS)");

  // Resolve the target package, never the host's rgPath when cross-building.
  const rgRequire = createRequire(execRequire.resolve("@vscode/ripgrep"));
  const cpu = arch === "armv7l" ? "arm" : arch;
  const name = `@vscode/ripgrep-${context.electronPlatformName}-${cpu}`;
  const binary = context.electronPlatformName === "win32" ? "rg.exe" : "rg";
  let rg;
  try {
    rg = rgRequire.resolve(`${name}/bin/${binary}`);
  } catch (cause) {
    throw new Error(
      `Missing ${name}@1.18.0; install optional dependencies for the target platform before packaging`,
      { cause },
    );
  }
  // Optional native dependencies must belong to the target, never the packaging host.
  const cuaRequire = createRequire(
    await realpath(join(desktop, "node_modules/@trycua/cua-driver/package.json")),
  );
  const suffix =
    context.electronPlatformName === "darwin"
      ? ""
      : context.electronPlatformName === "win32"
        ? "-msvc"
        : "-gnu";
  const cuaName = `@trycua/cua-driver-${context.electronPlatformName}-${arch}${suffix}`;
  const ubName = `@ubjs/node-${context.electronPlatformName}-${arch}${suffix}`;
  try {
    cuaRequire.resolve(`${cuaName}/package.json`);
    createRequire(cuaRequire.resolve("@ubjs/node/package.json")).resolve(`${ubName}/package.json`);
  } catch (cause) {
    throw new Error(
      `Missing target native packages ${cuaName} / ${ubName}; run pnpm install with the workspace supportedArchitectures settings`,
      { cause },
    );
  }
  if (context.electronPlatformName === "darwin") await prepareCuaDaemon(desktop, arch);
  const wasm = policyRequire.resolve("web-tree-sitter/web-tree-sitter.wasm");
  const bash = policyRequire.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  for (const [source, target] of [
    [
      rg,
      join(
        desktop,
        "out/native-resources",
        `${context.packager.platform.buildConfigurationKey}-${arch}`,
        "bin",
        binary,
      ),
    ],
    [wasm, join(desktop, "out/native-resources/wasm/web-tree-sitter.wasm")],
    [bash, join(desktop, "out/native-resources/wasm/tree-sitter-bash.wasm")],
  ]) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (source === rg) await chmod(target, 0o755);
    else if (!(await WebAssembly.validate(await readFile(target))))
      throw new Error(`Invalid parser WASM asset: ${target}`);
  }
  await prepareCodeMapGrammars(desktop, execRequire);
  const binDirectory = join(
    desktop,
    "out/native-resources",
    `${context.packager.platform.buildConfigurationKey}-${arch}`,
    "bin",
  );
  // Child Node workloads run on this helper, never on Pi Bot's executable.
  await prepareNodeHelper(desktop, context.electronPlatformName, arch, binDirectory);
  // Only Windows bundles Git; macOS and Linux use the system's.
  if (context.electronPlatformName === "win32") await prepareMinGit(desktop, arch, binDirectory);
}

/**
 * Code map: only each grammar's published .wasm and its tags queries ship (the grammar
 * packages are build-time devDependencies of execution, ~280 MB of C sources stay out). The
 * language table is shared with the runtime loader.
 */
async function prepareCodeMapGrammars(desktop, execRequire) {
  const table = JSON.parse(
    await readFile(join(desktop, "../../packages/execution/src/codemap/grammars.json"), "utf8"),
  );
  const out = join(desktop, "out/native-resources/wasm/codemap");
  await mkdir(out, { recursive: true });
  for (const language of table.languages) {
    const wasm = join(out, `${language.id}.wasm`);
    await copyFile(execRequire.resolve(`${language.package}/${language.wasm}`), wasm);
    if (!(await WebAssembly.validate(await readFile(wasm))))
      throw new Error(`Invalid code map grammar: ${language.id}`);
    const queries = await Promise.all(
      [
        ...language.tags.map((file) => execRequire.resolve(file)),
        ...(language.localTags ?? []).map((file) =>
          join(desktop, "../../packages/execution/src/codemap", file),
        ),
      ].map((file) => readFile(file, "utf8")),
    );
    await writeFile(join(out, `${language.id}.tags.scm`), queries.join("\n"));
  }
}
