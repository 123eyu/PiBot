import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { unbase64 } from "@pibot/link";

export interface PairedDesktop {
  version: 1;
  publicKey: string;
  rotation: string;
  relay: string;
  name: string;
}
export async function readPairedDesktop(dataDir: string): Promise<PairedDesktop | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      join(dataDir, "paired-desktop.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 4096 ||
      (process.platform !== "win32" && (info.mode & 0o077 || info.uid !== process.getuid?.()))
    )
      throw new Error("identity_corrupt");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("identity_corrupt");
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as PairedDesktop;
    if (
      Object.keys(value).sort().join(",") !== "name,publicKey,relay,rotation,version" ||
      value.version !== 1 ||
      typeof value.name !== "string" ||
      value.name.length > 200 ||
      typeof value.relay !== "string" ||
      value.relay.length > 1024
    )
      throw new Error("identity_corrupt");
    if (unbase64(value.publicKey, 32).length !== 32 || unbase64(value.rotation, 32).length !== 32)
      throw new Error("identity_corrupt");
    return value;
  } finally {
    await file.close();
  }
}
export async function savePairedDesktop(dataDir: string, value: PairedDesktop) {
  const temporary = join(dataDir, `paired-desktop-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, join(dataDir, "paired-desktop.json"));
    if (process.platform !== "win32") {
      const directory = await open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function forgetPairedDesktop(dataDir: string) {
  await unlink(join(dataDir, "phone-authorizations.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(join(dataDir, "paired-desktop.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (process.platform !== "win32") {
    const directory = await open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
