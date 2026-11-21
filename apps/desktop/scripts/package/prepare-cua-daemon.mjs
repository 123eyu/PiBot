import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { verifyTargetBinary } from "./verify-target-binary.ts";

export const CUA_DAEMON_VERSION = "0.38.0";
// Official cua-driver-rs-v0.38.0 GitHub release asset digests, pinned at review time.
export const CUA_DAEMON_ASSETS = {
  arm64: {
    cpu: "arm64",
    sha256: "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72",
  },
  x64: {
    cpu: "x86_64",
    sha256: "68721a916f2d9b20233a14623e0f663caf6130ba9018465a57a178120d96bc4e",
  },
};
export function verifyCuaArchive(bytes, arch) {
  const asset = CUA_DAEMON_ASSETS[arch];
  if (!asset || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Cua daemon release checksum mismatch");
}

/** Build-time only. No downloads, PATH lookup or fallback installation at application runtime. */
export async function prepareCuaDaemon(desktop, arch) {
  const asset = CUA_DAEMON_ASSETS[arch];
  if (!asset) throw new Error("Unsupported macOS Cua daemon architecture");
  const name = `cua-driver-rs-${CUA_DAEMON_VERSION}-darwin-${asset.cpu}`;
  const cache = join(desktop, ".cache", "cua-driver", CUA_DAEMON_VERSION);
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, "prepare-"));
  const archive = join(cache, `${name}.tar.gz`);
  try {
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(
        `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DAEMON_VERSION}/${name}.tar.gz`,
        {
          // 85 MB through a slow proxy took over two minutes; the digest check still guards the bytes.
          signal: AbortSignal.timeout(600_000),
        },
      );
      if (!response.ok) throw new Error(`Cua daemon download HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > 128 * 1024 * 1024)
        throw new Error("Cua daemon archive too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new Error("Cua daemon archive too large");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
      verifyCuaArchive(bytes, arch);
      const download = join(temporary, "download.tar.gz");
      await writeFile(download, bytes);
      await rename(download, archive);
    }
    verifyCuaArchive(bytes, arch);
    // Extract only the checksum-authenticated executable, never a release app bundle.
    const member = `${name}/cua-driver`;
    await promisify(execFile)("/usr/bin/tar", ["-xzf", archive, "-C", temporary, member], {
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const source = join(temporary, member);
    if (!(await lstat(source)).isFile()) throw new Error("Cua daemon must be a regular file");
    verifyTargetBinary(source, "darwin", arch);
    const destination = join(desktop, "out/native-resources", `mac-${arch}`);
    await mkdir(destination, { recursive: true });
    await copyFile(source, join(destination, "cua-driver"));
    await chmod(join(destination, "cua-driver"), 0o755);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Development can prepare the same resource without building or launching Electron.
if (
  process.argv[1] &&
  (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const desktop = (await import("node:url")).fileURLToPath(new URL("../../", import.meta.url));
  await prepareCuaDaemon(desktop, process.argv[2] ?? process.arch);
}
