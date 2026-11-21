import {
  IdSchema,
  OfflineAuditSchema,
  OfflineEgressSchema,
  OfflineManifestSchema,
  OfflineMemoryProposalSchema,
  OfflineRunnerReceiptSchema,
  OfflineSnapshotSchema,
  OfflineToolRecordSchema,
  OfflineUsageSchema,
  UserQuestionSchema,
} from "@pibot/protocol";
import { z } from "zod";
import type { LocalData } from "../storage/types.ts";

// What the phone keeps per paired computer for offline replies, in the app's private
// SQLite (the `mobile_cache` key/value table; `offline:` rows are never evicted like `cache:`).
// Model keys are not here: they live only in the secure store (`vault.ts`).

/** Long replies are cut on the phone, so one topic always fits one storage row (1 MB). */
export const LOCAL_TEXT_MAX = 8000;
/** A full topic is closed and a new one starts, keeping the row and the upload bounded. */
export const LOCAL_TOPIC_MESSAGES = 60;
const LEDGER_MAX = 200;
const TOPICS_MAX = 40;

export const LocalMessageSchema = z.strictObject({
  clientId: IdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().max(LOCAL_TEXT_MAX),
  status: z.enum(["done", "error", "aborted"]),
  createdAt: z.iso.datetime(),
  errorCode: z.string().max(60).optional(),
  usage: OfflineUsageSchema.optional(),
  tools: z.array(OfflineToolRecordSchema).max(20).optional(),
  question: UserQuestionSchema.optional(),
});
export type LocalMessage = z.infer<typeof LocalMessageSchema>;
export const LocalTopicSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  grantId: IdSchema,
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(256),
  createdAt: z.iso.datetime(),
  /**
   * Proposal 6: the Bot's computer topic this chat continues (its current topic in the phone's
   * copy when the chat began), so the replies join it on the computer. Absent: a topic of its own.
   */
  joinTopicId: IdSchema.optional(),
  /** Closed once the computer is back (or the topic is full); only closed topics upload. */
  state: z.enum(["open", "closed"]),
  messages: z.array(LocalMessageSchema).max(LOCAL_TOPIC_MESSAGES),
  runnerReceipts: z.array(OfflineRunnerReceiptSchema).max(32).optional(),
  audit: z.array(OfflineAuditSchema).max(200),
  memory: z.array(OfflineMemoryProposalSchema).max(20),
  egress: z.array(OfflineEgressSchema).max(200),
});
export type LocalTopic = z.infer<typeof LocalTopicSchema>;
export const LedgerEntrySchema = OfflineEgressSchema.extend({ botId: IdSchema });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
const KeyIndexSchema = z
  .array(z.strictObject({ grantId: IdSchema, digest: z.string().regex(/^[a-f0-9]{16,64}$/) }))
  .max(200);
const ids = z.array(IdSchema).max(64);

const key = {
  index: "offline:index",
  manifest: (c: string) => `offline:${c}:manifest`,
  snapshot: (c: string, botId: string) => `offline:${c}:snapshot:${botId}`,
  snapshots: (c: string) => `offline:${c}:snapshots`,
  keys: (c: string) => `offline:${c}:keys`,
  topics: (c: string) => `offline:${c}:topics`,
  topic: (c: string, id: string) => `offline:${c}:topic:${id}`,
  ledger: (c: string) => `offline:${c}:ledger`,
  choices: (c: string) => `offline:${c}:choices`,
};
const ChoiceSchema = z
  .array(
    z.strictObject({
      botId: IdSchema,
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      baselineProviderId: z.string().min(1),
      baselineModelId: z.string().min(1),
      changedAt: z.string().datetime(),
    }),
  )
  .max(100);
export type OfflineChoice = z.infer<typeof ChoiceSchema>[number];
/** Unreadable rows (a newer app wrote them, or storage was damaged) read as absent. */
async function read<T>(data: LocalData, name: string, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await data.get(name));
  return parsed.success ? parsed.data : undefined;
}

export class OfflineStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly data: LocalData) {}
  /** Read-modify-write rows (index, topic list, ledger) never interleave. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  computers() {
    return read(this.data, key.index, ids).then((v) => v ?? []);
  }
  private async remember(computerId: string) {
    const known = await this.computers();
    if (!known.includes(computerId))
      await this.data.put(key.index, ids.parse([...known, computerId].slice(-64)));
  }
  manifest(computerId: string) {
    return read(this.data, key.manifest(computerId), OfflineManifestSchema);
  }
  saveManifest(computerId: string, manifest: z.infer<typeof OfflineManifestSchema>) {
    return this.serial(async () => {
      await this.remember(computerId);
      await this.data.put(key.manifest(computerId), OfflineManifestSchema.parse(manifest));
    });
  }
  snapshot(computerId: string, botId: string) {
    return read(this.data, key.snapshot(computerId, botId), OfflineSnapshotSchema);
  }
  snapshotBots(computerId: string) {
    return read(this.data, key.snapshots(computerId), ids).then((v) => v ?? []);
  }
  saveSnapshot(computerId: string, snapshot: z.infer<typeof OfflineSnapshotSchema>) {
    return this.serial(async () => {
      await this.remember(computerId);
      await this.data.put(
        key.snapshot(computerId, snapshot.botId),
        OfflineSnapshotSchema.parse(snapshot),
      );
      const bots = await this.snapshotBots(computerId);
      if (!bots.includes(snapshot.botId))
        await this.data.put(key.snapshots(computerId), ids.parse([...bots, snapshot.botId]));
    });
  }
  dropSnapshot(computerId: string, botId: string) {
    return this.serial(async () => {
      await this.data.removePrefix(key.snapshot(computerId, botId));
      const bots = await this.snapshotBots(computerId);
      await this.data.put(
        key.snapshots(computerId),
        bots.filter((id) => id !== botId),
      );
    });
  }
  keyIndex(computerId: string) {
    return read(this.data, key.keys(computerId), KeyIndexSchema).then((v) => v ?? []);
  }
  saveKeyIndex(computerId: string, index: z.infer<typeof KeyIndexSchema>) {
    return this.serial(() => this.data.put(key.keys(computerId), KeyIndexSchema.parse(index)));
  }
  topicIds(computerId: string) {
    return read(this.data, key.topics(computerId), ids).then((v) => v ?? []);
  }
  topic(computerId: string, id: string) {
    return read(this.data, key.topic(computerId, id), LocalTopicSchema);
  }
  saveTopic(computerId: string, topic: LocalTopic) {
    return this.serial(async () => {
      const list = await this.topicIds(computerId);
      if (!list.includes(topic.id) && list.length >= TOPICS_MAX) throw new Error("offline_full");
      await this.remember(computerId);
      await this.data.put(key.topic(computerId, topic.id), LocalTopicSchema.parse(topic));
      if (!list.includes(topic.id))
        await this.data.put(key.topics(computerId), ids.parse([...list, topic.id]));
    });
  }
  removeTopic(computerId: string, id: string) {
    return this.serial(async () => {
      await this.data.removePrefix(key.topic(computerId, id));
      const list = await this.topicIds(computerId);
      await this.data.put(
        key.topics(computerId),
        list.filter((item) => item !== id),
      );
    });
  }
  ledger(computerId: string) {
    return read(this.data, key.ledger(computerId), z.array(LedgerEntrySchema).max(LEDGER_MAX)).then(
      (v) => v ?? [],
    );
  }
  choices(computerId: string) {
    return read(this.data, key.choices(computerId), ChoiceSchema).then((v) => v ?? []);
  }
  saveChoices(computerId: string, choices: OfflineChoice[]) {
    return this.serial(() => this.data.put(key.choices(computerId), ChoiceSchema.parse(choices)));
  }
  /** The phone's own privacy ledger: kept after upload so the owner can still see it here. */
  appendLedger(computerId: string, entry: LedgerEntry) {
    return this.serial(async () => {
      const rows = await this.ledger(computerId);
      await this.data.put(
        key.ledger(computerId),
        [LedgerEntrySchema.parse(entry), ...rows].slice(0, LEDGER_MAX),
      );
    });
  }
  /** Unpair, revoke or the computer's clear: everything offline for it goes (keys separately). */
  clear(computerId: string) {
    return this.serial(async () => {
      await this.data.removePrefix(`offline:${computerId}:`);
      const known = await this.computers();
      await this.data.put(
        key.index,
        known.filter((id) => id !== computerId),
      );
    });
  }
}
