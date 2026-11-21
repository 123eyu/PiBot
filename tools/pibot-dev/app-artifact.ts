import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { artifactRuntimeVersion } from "./app-artifact-runtime.ts";

export interface MacArtifact {
  path: string;
  platform: "darwin";
  arch: "arm64" | "x64";
  version: string;
  runtimeVersion?: string;
  digest: string;
}
type Run = (command: string, args: string[]) => string;
const run: Run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1 << 20 }).trim();

export function nativeMacDirectory(arch = process.arch) {
  if (arch !== "arm64" && arch !== "x64") throw new Error("mac_artifact_arch_unsupported");
  return arch === "arm64" ? "mac-arm64" : "mac";
}

function fileHash(path: string) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || realpathSync(path) !== resolve(path))
    throw new Error("mac_artifact_file_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
      throw new Error("mac_artifact_changed");
    const hash = createHash("sha256"),
      bytes = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    while (position < Number(before.size)) {
      const read = readSync(
        fd,
        bytes,
        0,
        Math.min(bytes.length, Number(before.size) - position),
        position,
      );
      if (!read) throw new Error("mac_artifact_changed");
      position += read;
      hash.update(bytes.subarray(0, read));
    }
    const after = lstatSync(path, { bigint: true });
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
    closeSync(fd);
  }
}

/** Verify bytes and the native executable, not merely an old dist directory's existence. */
export function inspectMacArtifact(
  input: string,
  options: { arch?: "arm64" | "x64"; run?: Run } = {},
): MacArtifact {
  const arch = options.arch ?? (process.arch as "arm64" | "x64");
  nativeMacDirectory(arch);
  const path = resolve(input);
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error("mac_artifact_bundle_invalid");
  const command = options.run ?? run;
  const plist = join(path, "Contents", "Info.plist");
  const field = (key: string) => command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  if (field("CFBundleIdentifier") !== "app.pibot.desktop") throw new Error("mac_artifact_app_id");
  const executable = field("CFBundleExecutable"),
    version = field("CFBundleShortVersionString");
  if (
    basename(executable) !== executable ||
    executable !== "Pi Bot" ||
    !version ||
    version.length > 100
  )
    throw new Error("mac_artifact_metadata_invalid");
  const main = join(path, "Contents", "MacOS", executable);
  const arches = command("/usr/bin/lipo", ["-archs", main]).split(/\s+/);
  if (!arches.includes(arch === "x64" ? "x86_64" : "arm64"))
    throw new Error("mac_artifact_arch_mismatch");
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  const archive = join(path, "Contents", "Resources", "app.asar");
  const archiveHash = fileHash(archive);
  const runtimeVersion = artifactRuntimeVersion(archive, version);
  if (fileHash(archive) !== archiveHash) throw new Error("mac_artifact_changed");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        fileHash(plist),
        fileHash(main),
        archiveHash,
        fileHash(join(path, "Contents", "_CodeSignature", "CodeResources")),
      ]),
    )
    .digest("hex");
  return { path, platform: "darwin", arch, version, runtimeVersion, digest };
}

const receipt = (worktree: string) =>
  join(worktree, "apps", "desktop", "dist", ".pibot-mac-artifact.json");
export function recordMacArtifact(worktree: string): MacArtifact {
  const artifact = inspectMacArtifact(
    join(worktree, "apps", "desktop", "dist", nativeMacDirectory(), "Pi Bot.app"),
  );
  const target = receipt(worktree),
    pending = `${target}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify(artifact)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(pending, target);
  return artifact;
}
export function builtMacArtifact(worktree: string): MacArtifact | undefined {
  const target = receipt(worktree);
  if (!existsSync(target)) return undefined;
  try {
    if (
      !lstatSync(target).isFile() ||
      lstatSync(target).size > 65536 ||
      realpathSync(target) !== resolve(target)
    )
      return undefined;
    const saved = JSON.parse(readFileSync(target, "utf8")) as MacArtifact;
    const expected = resolve(
      worktree,
      "apps",
      "desktop",
      "dist",
      nativeMacDirectory(),
      "Pi Bot.app",
    );
    if (saved.path !== expected) return undefined;
    const actual = inspectMacArtifact(expected);
    return saved.digest === actual.digest &&
      saved.arch === actual.arch &&
      saved.version === actual.version &&
      saved.runtimeVersion === actual.runtimeVersion
      ? actual
      : undefined;
  } catch {
    return undefined;
  }
}
