import { z } from "zod";
import {
  MESSAGE_FILE_BYTES,
  PENDING_FILE_BYTES,
  type ShareFiles,
} from "../features/share/upload.ts";
import type { Computer, PairResult, PendingMessage } from "../transport/link-port.ts";
import { type BlobFiles, FileCache } from "./file-cache.ts";
import { PhoneStore } from "./phone-store.ts";
import { ComputerSchema, type LocalData, PendingSchema, type SecretData } from "./types.ts";

export class MobileStorage {
  private tail: Promise<unknown> = Promise.resolve();
  readonly files: FileCache;
  /** Proposal 4: the phone-side copy screens render from first. */
  readonly store: PhoneStore;
  constructor(
    readonly data: LocalData,
    readonly secrets: SecretData,
    blobs: BlobFiles,
    /** Files of shared messages; without it the phone cannot share files. */
    readonly share?: ShareFiles,
  ) {
    this.files = new FileCache(data, blobs);
    this.store = new PhoneStore(data);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined); // The caller owns the error; later writes must still run.
    return next;
  }
  async computers(): Promise<Computer[]> {
    return z
      .array(ComputerSchema)
      .max(16)
      .parse((await this.data.get("registry")) ?? []);
  }
  savePair(pair: PairResult) {
    return this.serial(async () => {
      const computer = ComputerSchema.parse(pair.computer);
      const rows = await this.computers();
      if (!rows.some((d) => d.id === computer.id) && rows.length >= 16)
        throw new Error("device_limit");
      // Do not overwrite a known identity with a new scan before its ownership is settled.
      if (rows.some((d) => d.id === computer.id)) throw new Error("pair_exists");
      await this.secrets.set(computer.id, pair.credential);
      try {
        await this.data.put("registry", [...rows, computer]);
      } catch (error) {
        await this.secrets.remove(computer.id);
        throw error;
      }
    });
  }
  forget(id: string) {
    return this.serial(async () => {
      await this.secrets.remove(id);
      // Shared files still waiting to be sent to that computer go with its outbox.
      const waiting = await this.outbox(id).catch(() => []);
      for (const row of waiting) for (const file of row.files ?? []) this.share?.remove(file.blob);
      // A store write still on its way must not land after the rows are gone.
      await this.store.settled();
      await this.data.removePrefix(`cache:${id}:`);
      this.store.forget(id);
      await this.data.removePrefix(`outbox:${id}`);
      await this.data.removePrefix(`pref:${id}:`);
      // Unpairing clears the files cached from that computer.
      await this.files.clear(id);
      await this.data.put(
        "registry",
        (await this.computers()).filter((d) => d.id !== id),
      );
    });
  }
  async outbox(id: string): Promise<PendingMessage[]> {
    const rows = z
      .array(PendingSchema)
      .max(100)
      .parse((await this.data.get(`outbox:${id}`)) ?? []);
    if (
      rows.some((row) => row.computerId !== id) ||
      new Set(rows.map((row) => row.clientId)).size !== rows.length
    )
      throw new Error("outbox_scope_changed");
    return rows;
  }
  enqueue(message: PendingMessage) {
    return this.serial(async () => {
      const valid = PendingSchema.parse(message),
        rows = await this.outbox(valid.computerId);
      if (rows.length >= 100) throw new Error("outbox_full");
      const bytes = (valid.files ?? []).reduce((sum, file) => sum + file.bytes, 0);
      // Checked on the way in only: rows already queued stay readable whatever their size.
      if (bytes > MESSAGE_FILE_BYTES) throw new Error("attachments_too_large");
      if (bytes && bytes + (await this.pendingFileBytes()) > PENDING_FILE_BYTES)
        throw new Error("outbox_files_full");
      await this.data.put(`outbox:${valid.computerId}`, [...rows, valid]);
    });
  }
  /** Raw bytes of the files waiting in every paired computer's outbox. */
  private async pendingFileBytes() {
    let sum = 0;
    for (const computer of await this.computers())
      for (const row of await this.outbox(computer.id).catch(() => []))
        for (const file of row.files ?? []) sum += file.bytes;
    return sum;
  }
  /** Drops share-store files no outbox refers to (a draft or share the app was killed with). */
  sweepShare() {
    return this.serial(async () => {
      const stale = this.share?.stale?.(60 * 60_000) ?? [];
      if (!stale.length) return;
      const kept = new Set<string>();
      for (const computer of await this.computers())
        for (const row of await this.outbox(computer.id))
          for (const file of row.files ?? []) kept.add(file.blob);
      for (const blob of stale) if (!kept.has(blob)) this.share?.remove(blob);
    });
  }
  acknowledge(id: string, clientId: string) {
    return this.serial(async () => {
      const rows = await this.outbox(id);
      await this.data.put(
        `outbox:${id}`,
        rows.filter((m) => m.clientId !== clientId),
      );
      // Delivered: the computer stored the files as attachments; the phone copies can go.
      for (const file of rows.find((m) => m.clientId === clientId)?.files ?? [])
        this.share?.remove(file.blob);
    });
  }
  history(id: string, scope: string) {
    return this.store.history(id, scope);
  }
  cacheHistory(id: string, scope: string, messages: unknown[]) {
    return this.store.writeHistory(id, scope, messages);
  }
  async settled() {
    await this.tail;
    await this.store.settled();
    await this.files.settled();
  }
}
