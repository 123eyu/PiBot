import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCommand as command } from "./command.ts";

/**
 * @napi-rs/keyring's Windows build imports VCRUNTIME140.dll, which a clean Windows does not always
 * have (round 1 VM 2026-11-12: the runner could not open its credentials). The DLL is shipped next
 * to the .node file (Microsoft allows app-local deployment of the VC++ runtime). Source: the
 * python.org Windows embeddable package, pinned by version and SHA-256 of both the archive and DLL.
 */
const PYTHON = "3.13.1";
const ARCHIVE = `python-${PYTHON}-embed-amd64.zip`;
const ARCHIVE_SHA256 = "7b7923ff0183a8b8fca90f6047184b419b108cb437f75fc1c002f9d2f8bcec16";
const DLL_SHA256 = "36585912e5eaf83ba9fea0631534f690ccdc2d7ba91537166fe53e56c221e153";
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function archive(signal: AbortSignal) {
  const cache = join(repo, ".cache", "runner-vcruntime");
  const path = join(cache, ARCHIVE);
  try {
    const bytes = await readFile(path);
    if (sha256(bytes) === ARCHIVE_SHA256) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(`https://www.python.org/ftp/python/${PYTHON}/${ARCHIVE}`, {
    signal,
  });
  if (!response.ok) throw new Error(`vcruntime source download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 30 * 1024 * 1024 || sha256(bytes) !== ARCHIVE_SHA256)
    throw new Error("vcruntime source digest mismatch");
  await mkdir(cache, { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

/** Writes VCRUNTIME140.dll into `directory` (the keyring .node's folder) after verifying it. */
export async function copyVcruntime(directory: string) {
  const signal = AbortSignal.timeout(300_000);
  const zip = await archive(signal);
  const extracted = join(directory, ".vcruntime-extract");
  await mkdir(extracted, { recursive: true });
  await command("/usr/bin/unzip", ["-q", "-o", zip, "vcruntime140.dll", "-d", extracted]);
  const dll = await readFile(join(extracted, "vcruntime140.dll"));
  if (sha256(dll) !== DLL_SHA256) throw new Error("vcruntime digest mismatch");
  await writeFile(join(directory, "vcruntime140.dll"), dll);
  await rm(extracted, { recursive: true, force: true });
}
