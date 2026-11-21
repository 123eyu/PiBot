import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  BackgroundDescriptorSchema,
  BackgroundLoopbackEndpointSchema,
} from "@pibot/protocol/background";
import type { z } from "zod";

/** Host capability, not caller-supplied authorization: SDK never shells out to inspect Windows. */
export interface BackgroundDiscovery {
  read(dataDir: string, signal?: AbortSignal): Promise<unknown>;
  validateOwner(
    descriptor: z.infer<typeof BackgroundDescriptorSchema>,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Read-only discovery must never create a runtime directory or follow an owner-file link. */
export async function readDescriptor(
  dataDir: string,
  discovery?: BackgroundDiscovery,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (discovery) {
    const descriptor = BackgroundDescriptorSchema.parse(await discovery.read(dataDir, signal));
    BackgroundLoopbackEndpointSchema.parse(descriptor.endpoint);
    return descriptor;
  }
  if (process.platform === "win32") throw new Error("background_windows_verifier_required");
  const directory = join(await realpath(dataDir), "background-runtime");
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o7777) !== 0o700
  )
    throw new Error("background_descriptor_permissions");
  const path = join(directory, "owner.json");
  // Bigint stats keep NTFS-sized inodes exact (see execution core/file-identity.ts).
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("background_descriptor_permissions");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      !stat.isFile() ||
      Number(stat.uid) !== process.getuid?.() ||
      (Number(stat.mode) & 0o7777) !== 0o600 ||
      stat.size > 4096n
    )
      throw new Error("background_descriptor_permissions");
    // A bounded handle read keeps replacement/growth from changing the inspected file identity.
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("background_descriptor_permissions");
    let descriptor: ReturnType<typeof BackgroundDescriptorSchema.parse>;
    try {
      descriptor = BackgroundDescriptorSchema.parse(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      );
    } catch {
      throw new Error("background_descriptor_permissions");
    }
    if (descriptor.endpoint !== join(directory, "owner.sock"))
      throw new Error("background_endpoint_invalid");
    return descriptor;
  } finally {
    await file.close();
  }
}
