import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export async function prepareBrainResources(options: {
  dev: boolean;
  desktopDir: string;
  outputDir: string;
  packagedResourcesDir: string;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<string> {
  const binary = options.platform === "win32" ? "rg.exe" : "rg";
  let root = options.packagedResourcesDir;
  if (options.dev) {
    const desktopRequire = createRequire(join(options.desktopDir, "package.json"));
    const execRequire = createRequire(desktopRequire.resolve("@pibot/execution"));
    const policyRequire = createRequire(desktopRequire.resolve("@pibot/policy"));
    const rgRequire = createRequire(execRequire.resolve("@vscode/ripgrep"));
    const cpu = options.arch === "arm" ? "arm" : options.arch;
    root = join(options.outputDir, "..", "native-resources", `dev-${options.platform}-${cpu}`);
    // Development uses the same bin/wasm layout as extraResources without requiring a package build.
    const assets = [
      [
        rgRequire.resolve(`@vscode/ripgrep-${options.platform}-${cpu}/bin/${binary}`),
        "bin",
        binary,
      ],
      [
        policyRequire.resolve("web-tree-sitter/web-tree-sitter.wasm"),
        "wasm",
        "web-tree-sitter.wasm",
      ],
      [
        policyRequire.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
        "wasm",
        "tree-sitter-bash.wasm",
      ],
    ] as const;
    for (const [source, directory, name] of assets) {
      await mkdir(join(root, directory), { recursive: true });
      await copyFile(source, join(root, directory, name));
    }
    if (options.platform !== "win32") await chmod(join(root, "bin", binary), 0o755);
  }
  await Promise.all([
    access(
      join(root, "bin", binary),
      options.platform === "win32" ? constants.R_OK : constants.X_OK,
    ),
    access(join(root, "wasm", "web-tree-sitter.wasm"), constants.R_OK),
    access(join(root, "wasm", "tree-sitter-bash.wasm"), constants.R_OK),
  ]);
  return root;
}
