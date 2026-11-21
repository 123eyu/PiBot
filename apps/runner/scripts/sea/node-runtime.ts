import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCommand as command } from "./command.ts";
import type { Target } from "./types.ts";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
async function download(url: string, signal: AbortSignal, maxBytes: number) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Node runtime download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("Node runtime download exceeds limit");
  if (!response.body) throw new Error("Node runtime download has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("Node runtime download exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export async function nodeRuntime(target: Target, directory: string, version: string) {
  const runtimeDir = join(directory, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const executable = target.platform === "win32" ? "node.exe" : "node";
  const destination = join(runtimeDir, executable);
  if (target.platform === process.platform && target.arch === process.arch) {
    if (process.version !== `v${version}`)
      throw new Error(`Packaging requires Node v${version}; current runtime is ${process.version}`);
    await cp(process.execPath, destination);
    await cp(join(dirname(dirname(process.execPath)), "LICENSE"), join(runtimeDir, "LICENSE"));
  } else {
    const officialPlatform = target.platform === "win32" ? "win" : target.platform;
    const extension = target.platform === "win32" ? "zip" : "tar.gz";
    const archive = `node-v${version}-${officialPlatform}-${target.arch}.${extension}`;
    const base = `https://nodejs.org/dist/v${version}`;
    const signal = AbortSignal.timeout(300_000);
    const cache = join(repo, ".cache", "runner-node", version);
    await mkdir(cache, { recursive: true });
    const archiveCache = join(cache, archive);
    const cached = async (path: string, url: string, maxBytes: number) => {
      try {
        return await readFile(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const value = await download(url, signal, maxBytes);
        await writeFile(path, value, { mode: 0o600 });
        return value;
      }
    };
    const [checksumBytes, bytes] = await Promise.all([
      cached(join(cache, "SHASUMS256.txt"), `${base}/SHASUMS256.txt`, 5 * 1024 * 1024),
      cached(archiveCache, `${base}/${archive}`, 200 * 1024 * 1024),
    ]);
    const checksums = checksumBytes.toString("utf8");
    const expected = checksums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === archive)?.[0];
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected !== actual) {
      await rm(archiveCache, { force: true });
      throw new Error("Node runtime checksum mismatch");
    }
    const temporary = await mkdtemp(join(tmpdir(), "pibot-runner-node-"));
    try {
      const archivePath = join(temporary, archive);
      const extracted = join(temporary, "extracted");
      await mkdir(extracted);
      await writeFile(archivePath, bytes, { mode: 0o600 });
      if (extension === "zip") await command("unzip", ["-q", archivePath, "-d", extracted]);
      else await command("tar", ["-xzf", archivePath, "-C", extracted]);
      const root = join(extracted, archive.slice(0, -`.${extension}`.length));
      await cp(
        join(root, target.platform === "win32" ? executable : join("bin", executable)),
        destination,
      );
      await cp(join(root, "LICENSE"), join(runtimeDir, "LICENSE"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  if (target.platform !== "win32") await chmod(destination, 0o755);
}
