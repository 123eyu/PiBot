import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inspectNativeBinary } from "../rtc-prebuilt.ts";
import type { Target } from "./types.ts";

export async function inspectRunnerKeyring(deployed: string, target: Target) {
  const root = createRequire(join(deployed, "package.json"));
  const require = createRequire(root.resolve("@napi-rs/keyring"));
  const suffix = target.platform === "linux" ? "-gnu" : target.platform === "win32" ? "-msvc" : "";
  const name = `@napi-rs/keyring-${target.platform}-${target.arch}${suffix}`;
  const pkg = JSON.parse(await readFile(require.resolve(`${name}/package.json`), "utf8"));
  if (pkg.version !== "2.1.2" || pkg.license !== "MIT")
    throw new Error("runner_keyring_prebuilt_version_or_license");
  return {
    package: name,
    version: pkg.version,
    license: pkg.license,
    sha256: await inspectNativeBinary(require.resolve(name), target),
  };
}
