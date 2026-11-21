import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type MacArtifact, nativeMacDirectory } from "./app-artifact.ts";
import { artifactRuntimeVersionAsync } from "./app-artifact-runtime.ts";
import { runInstallCommand } from "./app-install-process.ts";

async function fileHash(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || (await realpath(path)) !== resolve(path))
    throw new Error("mac_artifact_file_invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
      throw new Error("mac_artifact_changed");
    const hash = createHash("sha256"),
      bytes = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    while (position < Number(before.size)) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        0,
        Math.min(bytes.length, Number(before.size) - position),
        position,
      );
      if (!bytesRead) throw new Error("mac_artifact_changed");
      position += bytesRead;
      hash.update(bytes.subarray(0, bytesRead));
    }
    signal.throwIfAborted();
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("mac_artifact_changed");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Install uses asynchronous commands and bounded reads so a caller can cancel large artifacts. */
export async function inspectMacArtifactAsync(
  input: string,
  signal: AbortSignal,
  options: { arch?: "arm64" | "x64"; run?: typeof runInstallCommand } = {},
): Promise<MacArtifact> {
  signal.throwIfAborted();
  const arch = options.arch ?? (process.arch as "arm64" | "x64");
  nativeMacDirectory(arch);
  const path = resolve(input),
    before = await lstat(path);
  if (!before.isDirectory() || (await realpath(path)) !== path)
    throw new Error("mac_artifact_bundle_invalid");
  const command = options.run ?? runInstallCommand;
  const plist = join(path, "Contents", "Info.plist");
  const field = (key: string) =>
    command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], signal);
  if ((await field("CFBundleIdentifier")) !== "app.pibot.desktop")
    throw new Error("mac_artifact_app_id");
  const executable = await field("CFBundleExecutable"),
    version = await field("CFBundleShortVersionString");
  if (
    basename(executable) !== executable ||
    executable !== "Pi Bot" ||
    !version ||
    version.length > 100
  )
    throw new Error("mac_artifact_metadata_invalid");
  const main = join(path, "Contents", "MacOS", executable);
  const arches = (await command("/usr/bin/lipo", ["-archs", main], signal)).split(/\s+/);
  if (!arches.includes(arch === "x64" ? "x86_64" : "arm64"))
    throw new Error("mac_artifact_arch_mismatch");
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], signal);
  const hashes: string[] = [];
  for (const file of [
    plist,
    main,
    join(path, "Contents", "Resources", "app.asar"),
    join(path, "Contents", "_CodeSignature", "CodeResources"),
  ])
    hashes.push(await fileHash(file, signal));
  const archive = join(path, "Contents", "Resources", "app.asar");
  const runtimeVersion = await artifactRuntimeVersionAsync(archive, version, signal);
  if ((await fileHash(archive, signal)) !== hashes[2]) throw new Error("mac_artifact_changed");
  signal.throwIfAborted();
  return {
    path,
    platform: "darwin",
    arch,
    version,
    runtimeVersion,
    digest: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
  };
}
