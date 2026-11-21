// Maintainers 2026-11-21: Windows builds ship MinGit, because most Windows computers have no Git
// and group parallel steps, the changes panel, commits and review all need it. System Git still
// wins at runtime (packages/execution/src/git/git-program.ts lists the bundled copy last).
//
// It ships as the release zip itself, not unpacked: the unpacked tree is ~380 files, ~190 of them
// executables and DLLs (89 MB), which the installer had to decompress and Windows Defender had to
// scan one by one; installs went from 47 s to 108-143 s. Pi Bot unpacks the zip once, on first
// need, into its own cache (packages/execution/src/git/bundled-git.ts), after checking the digest
// this script writes into mingit.json.
//
// Official Git for Windows release, exact version, SHA-256 pinned here (the release notes' table
// and GitHub's asset digest agree) and checked before anything is unpacked. Shipped unmodified
// under GPLv2; the source link is in apps/desktop/resources/licenses/mingit.md.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const MINGIT_VERSION = "2.56.1";
const RELEASE = "v2.56.1.windows.1";
export const MINGIT_DIGESTS = {
  x64: [
    "MinGit-2.56.1-64-bit.zip",
    "4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd",
  ],
  arm64: [
    "MinGit-2.56.1-arm64.zip",
    "96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c",
  ],
};
const MAX_ARCHIVE = 100 * 1024 * 1024;
const run = promisify(execFile);

/**
 * Downloads (or reuses from .cache) and verifies MinGit for one Windows architecture, then
 * replaces `<binDirectory>/mingit` with the verified zip, its manifest and the licence text.
 */
export async function prepareMinGit(desktop, arch, binDirectory) {
  const entry = MINGIT_DIGESTS[arch];
  if (!entry) throw new Error(`No pinned MinGit for win-${arch}`);
  const [name, expected] = entry;
  const cache = join(desktop, "../../.cache/pibot-mingit", RELEASE);
  await mkdir(cache, { recursive: true });
  const archive = join(cache, name);
  let bytes;
  let downloaded = false;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    const response = await fetch(
      `https://github.com/git-for-windows/git/releases/download/${RELEASE}/${name}`,
      { signal: AbortSignal.timeout(300_000) },
    );
    if (!response.ok) throw new Error(`MinGit download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_ARCHIVE) throw new Error("MinGit archive exceeds limit");
    bytes = buffer;
    downloaded = true;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    await rm(archive, { force: true });
    throw new Error(`MinGit checksum mismatch for win-${arch}`);
  }
  if (downloaded) await writeFile(archive, bytes, { mode: 0o600 });
  // The launcher must be in the archive; the licence travels beside it as well as inside it.
  const { stdout: listing } = await run("unzip", ["-Z1", archive], { maxBuffer: 4 * 1024 * 1024 });
  const names = new Set(listing.split(/\r?\n/));
  if (!names.has("cmd/git.exe") || !names.has("LICENSE.txt"))
    throw new Error(`MinGit archive for win-${arch} lacks cmd/git.exe or LICENSE.txt`);
  const { stdout: licence } = await run("unzip", ["-p", archive, "LICENSE.txt"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  // Builds before the zip layout left the unpacked tree in the same output folder.
  await rm(join(binDirectory, "git"), { recursive: true, force: true });
  const target = join(binDirectory, "mingit");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copyFile(archive, join(target, name));
  // The cache copy is private to the builder; the shipped one is an ordinary resource file.
  await chmod(join(target, name), 0o644);
  await writeFile(join(target, "LICENSE.txt"), licence);
  const manifest = {
    release: RELEASE,
    version: MINGIT_VERSION,
    archive: name,
    sha256: actual,
    size: bytes.byteLength,
  };
  await writeFile(join(target, "mingit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(JSON.stringify({ event: "package.mingit", ...manifest, target: `win-${arch}` }));
  return join(target, name);
}
