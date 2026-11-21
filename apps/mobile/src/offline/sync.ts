import {
  type MethodParams,
  type MethodResults,
  OFFLINE_UPLOAD_MESSAGES,
  type OfflineRunnerReceipt,
  OfflineSnapshotSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { LocalMessage, LocalTopic, OfflineStore } from "./store.ts";
import { encodeCredential, type KeyVault } from "./vault.ts";

type OfflineMethod =
  | "remote.runnerControl.pull"
  | "remote.offline.manifest"
  | "remote.offline.snapshot"
  | "remote.offline.upload";
export type OfflineCall = <K extends OfflineMethod>(
  method: K,
  params: MethodParams[K],
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<MethodResults[K]>;
// Below the 900 kB session frame (counted in UTF-8 bytes there) with the envelope to spare.
const PART_BYTES = 600_000;
const encoder = new TextEncoder();

/**
 * Computer → phone: compare versions, then pull only what changed. Keys arrive inside the
 * manifest answer, only for models the user delivered; any key whose model is no longer delivered
 * (un-checked, removed, revoked) is deleted from the secure store here.
 */
export async function pullOffline(
  call: OfflineCall,
  store: OfflineStore,
  vault: KeyVault,
  computerId: string,
  signal: AbortSignal,
) {
  const stored = await store.manifest(computerId);
  const index = await store.keyIndex(computerId);
  const answer = await call(
    "remote.offline.manifest",
    { ...(stored ? { ifVersion: stored.version } : {}), keys: index },
    signal,
    20_000,
  );
  const manifest = answer.manifest ?? (stored?.version === answer.version ? stored : undefined);
  if (!manifest) throw new Error("offline_manifest_missing");
  signal.throwIfAborted();
  const digests = new Map(index.map((entry) => [entry.grantId, entry.digest]));
  for (const delivery of answer.keys) {
    await vault.set(
      computerId,
      delivery.grantId,
      encodeCredential({
        key: delivery.key,
        ...(delivery.headers ? { headers: delivery.headers } : {}),
      }),
    );
    digests.set(delivery.grantId, delivery.digest);
  }
  const delivered = new Set(manifest.models.filter((m) => m.delivered).map((m) => m.grantId));
  for (const grantId of [...digests.keys()])
    if (!delivered.has(grantId)) {
      await vault.remove(computerId, grantId);
      digests.delete(grantId);
    }
  await store.saveKeyIndex(
    computerId,
    [...digests].map(([grantId, digest]) => ({ grantId, digest })),
  );
  await store.saveManifest(computerId, manifest);
  for (const bot of manifest.bots) {
    signal.throwIfAborted();
    if (!bot.snapshotVersion) {
      if (await store.snapshot(computerId, bot.id)) await store.dropSnapshot(computerId, bot.id);
      continue;
    }
    if ((await store.snapshot(computerId, bot.id))?.version === bot.snapshotVersion) continue;
    const snapshot = OfflineSnapshotSchema.parse(
      await call("remote.offline.snapshot", { botId: bot.id }, signal, 20_000),
    );
    await store.saveSnapshot(computerId, snapshot);
  }
  for (const botId of await store.snapshotBots(computerId))
    if (!manifest.bots.some((bot) => bot.id === botId && bot.snapshotVersion))
      await store.dropSnapshot(computerId, botId);
  return manifest;
}

function uploadMessage(message: LocalMessage) {
  // A choice card with no other text still reads as the question on the computer.
  const content =
    message.content ||
    (message.question
      ? [message.question.prompt, ...message.question.options.map((o) => `- ${o.label}`)].join("\n")
      : "");
  return {
    clientId: message.clientId,
    role: message.role,
    content,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.tools?.length ? { tools: message.tools } : {}),
    ...(message.question ? { question: message.question } : {}),
  };
}
/** Message parts under the frame and count caps; the records ride with the last part. */
export function uploadParts(topic: LocalTopic) {
  const parts: ReturnType<typeof uploadMessage>[][] = [[]];
  let size = 0;
  for (const message of topic.messages.map(uploadMessage)) {
    const cost = encoder.encode(JSON.stringify(message)).length;
    const current = parts.at(-1) as ReturnType<typeof uploadMessage>[];
    if (current.length && (current.length >= OFFLINE_UPLOAD_MESSAGES || size + cost > PART_BYTES)) {
      parts.push([message]);
      size = cost;
    } else {
      current.push(message);
      size += cost;
    }
  }
  // Receipt paths/commands are independently bounded but may together exceed a link frame.
  // Keep a receipt batch separate from message payloads and the final audit batch.
  const receipts = new Map<number, OfflineRunnerReceipt[]>();
  let receiptSize = 0,
    receiptPart = -1;
  for (const receipt of topic.runnerReceipts ?? []) {
    const cost = encoder.encode(JSON.stringify(receipt)).length;
    if (receiptPart < 0 || receiptSize + cost > 350_000) {
      receiptPart = parts.length;
      parts.push([]);
      receipts.set(receiptPart, []);
      receiptSize = 0;
    }
    receipts.get(receiptPart)?.push(receipt);
    receiptSize += cost;
  }
  if (receipts.size) parts.push([]);
  return parts.map((messages, part) => {
    const final = part === parts.length - 1;
    return {
      localTopicId: topic.id,
      botId: topic.botId,
      ...(topic.joinTopicId ? { topicId: topic.joinTopicId } : {}),
      grantId: topic.grantId,
      providerId: topic.providerId,
      modelId: topic.modelId,
      part,
      final,
      messages,
      audit: final ? topic.audit : [],
      ...(receipts.has(part) ? { runnerReceipts: receipts.get(part) } : {}),
      memory: final ? topic.memory : [],
      egress: final ? topic.egress : [],
    };
  });
}

/**
 * A computer from before proposal 6 refuses the unknown `topicId` as invalid params (its schema
 * is strict, so nothing was imported): the part goes again without it and the chat gets a topic
 * of its own there. The import's own refusals are named `offline_*` and are not retried here.
 */
async function uploadPart(
  call: OfflineCall,
  part: ReturnType<typeof uploadParts>[number],
  signal: AbortSignal,
) {
  try {
    return await call("remote.offline.upload", part, signal, 60_000);
  } catch (error) {
    if (
      !part.topicId ||
      !(error instanceof RpcError) ||
      error.code !== RpcErrorCodes.invalidParams ||
      error.message.startsWith("offline_")
    )
      throw error;
    const { topicId: _joined, ...older } = part;
    return call("remote.offline.upload", older, signal, 60_000);
  }
}
/**
 * Phone → computer: every closed topic, in parts. A repeated upload is harmless (the
 * computer keys each item by its client ID), so a lost receipt is simply sent again next time.
 * Returns how many topics are still waiting.
 */
export async function pushOffline(
  call: OfflineCall,
  store: OfflineStore,
  computerId: string,
  signal: AbortSignal,
) {
  let waiting = 0;
  for (const id of await store.topicIds(computerId)) {
    signal.throwIfAborted();
    const topic = await store.topic(computerId, id);
    if (!topic) {
      await store.removeTopic(computerId, id);
      continue;
    }
    if (topic.state !== "closed") continue;
    if (!topic.messages.length) {
      await store.removeTopic(computerId, id);
      continue;
    }
    try {
      for (const part of uploadParts(topic)) await uploadPart(call, part, signal);
      await store.removeTopic(computerId, id);
    } catch (error) {
      if (signal.aborted) throw error;
      // The Bot is gone on the computer: there is nowhere to put the chat, keeping it only blocks.
      if (error instanceof RpcError && error.message === "offline_bot_unavailable") {
        await store.removeTopic(computerId, id);
        continue;
      }
      waiting++;
    }
  }
  return waiting;
}
