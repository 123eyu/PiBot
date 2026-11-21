import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertPhoneControlCurrent, verifyPhoneControl } from "@pibot/link";
import { type PhoneControlGrant, PhoneControlGrantsSchema } from "@pibot/protocol-base";
import { readPairedDesktop } from "./paired-desktop.ts";

/** Only the currently paired computer may advance a phone's durable revision. */
export async function openPhoneAuthorizations(dataDir: string, runnerPublic: string) {
  const path = join(dataDir, "phone-authorizations.json");
  let grants = new Map<string, PhoneControlGrant>();
  const listeners = new Set<() => void>();
  let tail: Promise<unknown> = Promise.resolve();
  const paired = await readPairedDesktop(dataDir);
  if (paired) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 256 * 1024 ||
        (process.platform !== "win32" && (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
      )
        throw new Error("phone_authorizations_corrupt");
      const bytes = Buffer.alloc(256 * 1024 + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 256 * 1024) throw new Error("phone_authorizations_corrupt");
      const values = PhoneControlGrantsSchema.parse(
        JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")),
      );
      if (
        values.length &&
        values.every((v) => v.body.issuer !== paired.publicKey || v.body.runner !== runnerPublic)
      ) {
        await unlink(path);
      } else
        for (const value of values) {
          const grant = verifyPhoneControl(value, paired.publicKey, runnerPublic);
          if (grants.has(grant.body.phone)) throw new Error("phone_authorizations_corrupt");
          grants.set(grant.body.phone, grant);
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }
  return {
    list: () => [...grants.values()],
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async assert(grant: PhoneControlGrant) {
      const desktop = await readPairedDesktop(dataDir);
      if (!desktop) throw new Error("authorization_revoked");
      verifyPhoneControl(grant, desktop.publicKey, runnerPublic);
      const current = grants.get(grant.body.phone);
      if (!current || current.signature !== grant.signature)
        throw new Error("authorization_revoked");
      assertPhoneControlCurrent(current);
    },
    update(values: PhoneControlGrant[]) {
      const work = tail.then(async () => {
        const desktop = await readPairedDesktop(dataDir);
        if (!desktop) throw new Error("authorization_revoked");
        const next = new Map(grants);
        for (const value of values) {
          const grant = verifyPhoneControl(value, desktop.publicKey, runnerPublic);
          const known = next.get(grant.body.phone);
          if (known && grant.body.revision < known.body.revision)
            throw new Error("authorization_rollback");
          if (
            known &&
            grant.body.revision === known.body.revision &&
            grant.signature !== known.signature
          )
            throw new Error("authorization_conflict");
          if (grant.body.issuedAt > Date.now() + 60_000) throw new Error("authorization_clock");
          next.set(grant.body.phone, grant);
        }
        for (const [phone, grant] of next)
          if (grant.body.expiresAt <= Date.now()) next.delete(phone);
        if (next.size > 100) throw new Error("authorization_capacity");
        if (
          next.size === grants.size &&
          [...next].every(([phone, grant]) => grants.get(phone)?.signature === grant.signature)
        )
          return;
        const body = JSON.stringify([...next.values()]);
        if (Buffer.byteLength(body) > 256 * 1024) throw new Error("authorization_capacity");
        const temporary = join(dataDir, `phone-authorizations-${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(body);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          if (process.platform !== "win32") {
            const directory = await open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          }
          grants = next;
          for (const fn of listeners) fn();
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      });
      tail = work.catch(() => {});
      return work;
    },
    async dispose() {
      await tail;
      listeners.clear();
    },
  };
}
