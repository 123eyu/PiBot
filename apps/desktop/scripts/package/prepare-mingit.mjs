// Maintainers 2026-11-21: Windows builds ship MinGit, because most Windows computers have no Git
// and group parallel steps, the changes panel, commits and review all need it. System Git still
// wins at runtime (packages/execution/src/git/git-program.ts lists the bundled copy last).
//
// Official Git for Windows release, exact version, SHA-256 pinned here (the release notes' table
// and GitHub's asset digest agree) and checked before anything is unpacked. Shipped unmodified
// under GPLv2; the source link is in apps/desktop/resources/licenses/mingit.md.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const MINGIT_VERSION = "2.56.1";
const RELEASE = "v2.56.1.windows.1";
const DIGESTS = {
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
 * replaces `<binDirectory>/git` with the unpacked tree; `git/cmd/git.exe` is what runtime looks for.
 */
export async function prepareMinGit(desktop, arch, binDirectory) {
  const entry = DIGESTS[arch];
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
  const temporary = await mkdtemp(join(tmpdir(), "pibot-mingit-"));
  try {
    await run("unzip", ["-q", archive, "-d", temporary]);
    // The launcher and the licence must exist before the previous copy is replaced.
    await Promise.all([
      access(join(temporary, "cmd", "git.exe")),
      access(join(temporary, "LICENSE.txt")),
    ]);
    const target = join(binDirectory, "git");
    await rm(target, { recursive: true, force: true });
    await mkdir(binDirectory, { recursive: true });
    await cp(temporary, target, { recursive: true });
    console.info(
      JSON.stringify({
        event: "package.mingit",
        version: MINGIT_VERSION,
        release: RELEASE,
        target: `win-${arch}`,
        sha256: actual,
      }),
    );
    return join(target, "cmd", "git.exe");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
