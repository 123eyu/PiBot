import type { Model, PortableApi } from "@pibot/agent/portable";
import type { OfflineManifest, OfflineModel } from "@pibot/protocol";
import { OFFLINE_RUNNER_TOOLS } from "@pibot/protocol";
import { appendPhoneDataLog, readPhoneDataPrefs } from "../features/phone-data/prefs.ts";
import { phoneDataHandler } from "../features/phone-data/serve.ts";
import type { PhoneDataNative } from "../runtime/runtime.ts";
import { StoredTopicsSchema, storeKeys } from "../storage/phone-store.ts";
import type { LocalData } from "../storage/types.ts";
import type { ConnectionStatus, MobilePeer } from "../transport/session.ts";
import { runOfflineReply, type Stream } from "./loop.ts";
import { offlineRedactor } from "./redact.ts";
import { pullRunnerAuthorizations, RUNNER_AUTHORIZATION_SLOT } from "./runner-authorizations.ts";
import { type OfflineRunnerDeps, OfflineRunnerTools, type RunnerApproval } from "./runner-tools.ts";
import type { OfflineChoice } from "./store.ts";
import {
  type LedgerEntry,
  LOCAL_TEXT_MAX,
  LOCAL_TOPIC_MESSAGES,
  type LocalMessage,
  type LocalTopic,
  OfflineStore,
} from "./store.ts";
import { type OfflineCall, pullOffline, pushOffline } from "./sync.ts";
import { runOfflineTool } from "./tools.ts";
import { decodeCredential, type KeyVault } from "./vault.ts";

/** What the engine reads from the app runtime (MobileRuntime satisfies it). */
/** Regular re-check with the computer while connected (maintainers 2026-11-12). */
const RESYNC_MS = 15 * 60_000;

export interface OfflineHost {
  getSnapshot(): {
    ready: boolean;
    status: ConnectionStatus;
    selectedId?: string;
    devices: readonly { id: string; publicKey?: string }[];
    peer: MobilePeer | null;
  };
  subscribe(listener: () => void): () => void;
  call: OfflineCall;
  updateBot?: (
    botId: string,
    providerId: string,
    modelId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  getBot?: (
    botId: string,
    signal: AbortSignal,
  ) => Promise<{ updatedAt: string; modelProvider?: string | null; modelId?: string | null }>;
}
export interface OfflineDeps {
  host: OfflineHost;
  data: LocalData;
  vault: KeyVault;
  phone: PhoneDataNative;
  /** `streamPortable` in the app; the acceptance passes the same function. */
  stream: Stream;
  runnerConnection?: (
    computerId: string,
    target: string,
    signal: AbortSignal,
  ) => ReturnType<OfflineRunnerDeps["connect"]>;
  uuid?: () => string;
  now?: () => Date;
}
export interface LiveReply {
  botId: string;
  topicId: string;
  clientId: string;
  text: string;
  /** Earlier replies of this run that are already complete, shown as their own messages. */
  parts?: string[];
}
export interface OfflineState {
  runnerApproval?: RunnerApproval;
  runnerOutput?: { botId: string; text: string };
  computerId?: string;
  /**
   * The computer is unreachable (the connection reported offline); kept through the background,
   * cleared once the phone connects or tries the computer again (online / connecting).
   */
  unreachable: boolean;
  manifest?: OfflineManifest;
  /** Bots that can reply on this phone right now (snapshot, delivered key and model all here). */
  ready: readonly string[];
  /** The open offline topic of each Bot, for the chat page. */
  topics: Readonly<Record<string, LocalTopic>>;
  live?: LiveReply;
  /** Closed topics still to go to the computer. */
  waiting: number;
  ledger: readonly LedgerEntry[];
  revision: number;
  choices: readonly OfflineChoice[];
  conflicts: readonly string[];
}

const truncate = (text: string) => Array.from(text).slice(0, LOCAL_TEXT_MAX).join("");
function portableModel(model: OfflineModel): Model<PortableApi> {
  return {
    id: model.modelId,
    name: model.modelName,
    api: model.api,
    provider: model.providerId,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * The phone's own replies while the computer is unreachable. Online, nothing runs here:
 * the engine only syncs (pull the manifest, snapshots and keys; push closed offline topics). Once
 * the connection reports the computer offline, a Bot that is ready answers on the phone; a reply
 * already running finishes even if the computer comes back meanwhile, then everything syncs.
 */
/**
 * T7: one provider grant covers many models, so the Bot's own model is chosen by id; a Bot
 * without one (older snapshot) falls back to the first delivered model of its provider.
 */
function offlineModelFor(
  manifest: { models: readonly OfflineModel[] } | undefined,
  bot: { grantId: string | null; modelId?: string | null },
) {
  const delivered = manifest?.models.filter((m) => m.grantId === bot.grantId && m.delivered) ?? [];
  return bot.modelId ? delivered.find((m) => m.modelId === bot.modelId) : delivered[0];
}

/**
 * F22: the delivered models the Bots use. An older computer sends a router provider's whole
 * catalog marked delivered (hundreds of rows); a Bot can only answer with its own model offline.
 */
export function usedOfflineModels(manifest: Pick<OfflineManifest, "models" | "bots"> | undefined) {
  const used = new Set(
    (manifest?.bots ?? []).map((bot) => JSON.stringify([bot.grantId, bot.modelId ?? null])),
  );
  return (manifest?.models ?? []).filter(
    (model) => model.delivered && used.has(JSON.stringify([model.grantId, model.modelId])),
  );
}

export class OfflineEngine {
  readonly store: OfflineStore;
  private state: OfflineState = {
    unreachable: false,
    ready: [],
    topics: {},
    waiting: 0,
    ledger: [],
    revision: 0,
    choices: [],
    conflicts: [],
  };
  private listeners = new Set<() => void>();
  private offHost?: () => void;
  private offPeer: (() => void)[] = [];
  private peer: MobilePeer | null = null;
  private lastStatus?: ConnectionStatus;
  private lastDevices = "";
  private syncing?: Promise<void>;
  private syncScope?: AbortController;
  private syncAgain = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private lifetime = new AbortController();
  private reply?: AbortController;
  private sending?: Promise<LocalMessage>;
  private runnerCleanup?: () => Promise<void>;
  private settleApproval?: (approved: boolean) => void;
  private readonly uuid: () => string;
  private readonly now: () => Date;
  constructor(private readonly deps: OfflineDeps) {
    this.store = new OfflineStore(deps.data);
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date());
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(value: Partial<OfflineState>) {
    this.state = { ...this.state, ...value, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  /** Subscribes to the app runtime; `stop` undoes it (a remount may start again). */
  start() {
    this.offHost?.();
    this.lifetime = new AbortController();
    this.lastStatus = undefined;
    this.lastDevices = "";
    this.offHost = this.deps.host.subscribe(() => void this.hostChanged());
    void this.hostChanged();
  }
  async stop() {
    this.lifetime.abort();
    this.syncScope?.abort();
    clearTimeout(this.retry);
    this.reply?.abort();
    this.settleApproval?.(false);
    await this.sending?.catch(() => undefined);
    await this.runnerCleanup?.();
    this.runnerCleanup = undefined;
    this.offHost?.();
    this.offHost = undefined;
    this.watch(null);
    await this.syncing;
  }
  /** Ready to answer this Bot on the phone now. */
  canReply(botId: string) {
    return (
      (this.state.unreachable && this.state.ready.includes(botId)) ||
      this.state.live?.botId === botId
    );
  }
  private async hostChanged() {
    const host = this.deps.host.getSnapshot();
    if (!host.ready || this.lifetime.signal.aborted) return;
    // The runtime publishes often (uploads, deliveries); act only on what changed here.
    const devices = host.devices.map((d) => d.id).join(",");
    if (devices !== this.lastDevices) {
      this.lastDevices = devices;
      await this.forgetUnpaired(host.devices.map((d) => d.id));
    }
    const computerId = host.selectedId;
    if (computerId !== this.state.computerId) {
      this.syncScope?.abort();
      this.reply?.abort();
      this.settleApproval?.(false);
      this.patch({
        computerId,
        unreachable: false,
        live: undefined,
        runnerApproval: undefined,
        runnerOutput: undefined,
      });
      this.lastStatus = undefined;
      await this.load();
    }
    const previousStatus = this.lastStatus;
    const entered = host.status !== previousStatus;
    this.lastStatus = host.status;
    // Only the session's verdict "offline" hands chats to the phone's model. "connecting" (a
    // reconnect, the first attempt after a start) keeps them with the computer and sends wait in
    // the outbox: v0.0.2, a message typed during a 4 s reconnect went to the phone's model and
    // never reached the computer. "suspended" (background) says nothing new and keeps the last.
    if (host.status === "offline" && !this.state.unreachable) this.patch({ unreachable: true });
    if (host.status === "connecting" && this.state.unreachable && !this.state.live)
      this.patch({ unreachable: false });
    if (host.status === "online") {
      this.settleApproval?.(false);
      if (this.state.unreachable) this.patch({ unreachable: false });
      const fresh = host.peer !== this.peer;
      if (fresh) this.watch(host.peer);
      if (entered || fresh || this.state.choices.length) void this.sync();
    } else if (this.peer) this.watch(null);
  }
  /** The computer asks to pull again (its grants or a Bot changed) or to clear everything. */
  private watch(peer: MobilePeer | null) {
    if (peer !== this.peer) this.syncScope?.abort();
    for (const off of this.offPeer) off();
    this.offPeer = [];
    this.peer = peer;
    if (!peer) return;
    this.offPeer = [
      peer.on("remote.offline.changed", (event) => {
        const computerId = this.state.computerId;
        if (event.clear && computerId) void this.clearComputer(computerId).then(() => this.load());
        else void this.sync();
      }),
      peer.on("bots.changed", () => void this.sync()),
      peer.on("endpoints.changed", () => void this.sync()),
      peer.on("sidebar.changed", () => void this.sync()),
    ];
    // Maintainers 2026-11-12: no key expiry; instead the phone re-checks with the computer regularly
    // while connected, so a key changed or withdrawn there follows here without an event.
    const timer = setInterval(() => void this.sync(), RESYNC_MS);
    this.offPeer.push(() => clearInterval(timer));
  }
  /** Unpairing on the phone clears what it holds for that computer. */
  private async forgetUnpaired(paired: readonly string[]) {
    for (const id of await this.store.computers())
      if (!paired.includes(id)) await this.clearComputer(id);
  }
  async clearComputer(computerId: string) {
    if (this.state.computerId === computerId) {
      this.syncScope?.abort();
      this.reply?.abort();
    }
    await this.deps.vault.remove(computerId, RUNNER_AUTHORIZATION_SLOT);
    const manifest = await this.store.manifest(computerId);
    const grants = new Set([
      ...(await this.store.keyIndex(computerId)).map((k) => k.grantId),
      ...(manifest?.models.map((m) => m.grantId) ?? []),
    ]);
    for (const grantId of grants) await this.deps.vault.remove(computerId, grantId);
    await this.store.clear(computerId);
  }
  /** What the chat page shows: the manifest, ready Bots and open topics of this computer. */
  private async load() {
    const computerId = this.state.computerId;
    if (!computerId) {
      this.patch({
        manifest: undefined,
        ready: [],
        topics: {},
        waiting: 0,
        ledger: [],
        choices: [],
        conflicts: [],
      });
      return;
    }
    const manifest = await this.store.manifest(computerId);
    const index = new Set((await this.store.keyIndex(computerId)).map((k) => k.grantId));
    const ready: string[] = [];
    for (const bot of manifest?.bots ?? []) {
      const model = offlineModelFor(manifest, bot);
      if (!bot.offline || !model || !index.has(model.grantId)) continue;
      if ((await this.store.snapshot(computerId, bot.id))?.version !== bot.snapshotVersion)
        continue;
      ready.push(bot.id);
    }
    const topics: Record<string, LocalTopic> = {};
    let waiting = 0;
    for (const id of await this.store.topicIds(computerId)) {
      const topic = await this.store.topic(computerId, id);
      if (topic?.state === "open") topics[topic.botId] = topic;
      else if (topic) waiting++;
    }
    if (computerId !== this.state.computerId) return;
    this.patch({
      manifest,
      ready,
      topics,
      waiting,
      ledger: await this.store.ledger(computerId),
      choices: await this.store.choices(computerId),
    });
  }
  /** One sync at a time; a request during a sync runs once more after it. */
  sync() {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncAgain = false;
    this.syncing = this.syncOnce()
      .then(() => {
        this.retries = 0;
      })
      .catch(() => {
        // A failed pull keeps what the phone has. The status turns online a moment before the
        // link carries calls (probe 2026-11-12: offline-model choices stayed queued), so while
        // online retry a few times, backing off; otherwise the next connect tries again.
        if (this.lifetime.signal.aborted || this.retries >= 5) return;
        if (this.deps.host.getSnapshot().status !== "online") return;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => void this.sync(), 1000 * 2 ** this.retries++);
      })
      .finally(() => {
        this.syncing = undefined;
        if (this.syncAgain && !this.lifetime.signal.aborted) void this.sync();
      });
    return this.syncing;
  }
  private async syncOnce() {
    const computerId = this.state.computerId;
    const host = this.deps.host.getSnapshot();
    // Online only, and never under a reply still running here (it finishes first).
    if (!computerId || host.status !== "online" || this.state.live) return;
    this.syncScope?.abort();
    this.syncScope = new AbortController();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.syncScope.signal,
      AbortSignal.timeout(120_000),
    ]);
    const { updateBot, getBot } = this.deps.host;
    if (updateBot) {
      const pending = await this.store.choices(computerId);
      for (const choice of pending) {
        if (getBot) {
          const current = await getBot(choice.botId, signal);
          if (
            current.modelProvider !== choice.baselineProviderId ||
            current.modelId !== choice.baselineModelId
          ) {
            await this.store.saveChoices(
              computerId,
              (await this.store.choices(computerId)).filter((row) => row.botId !== choice.botId),
            );
            this.patch({ conflicts: [...new Set([...this.state.conflicts, choice.botId])] });
            continue;
          }
        }
        await updateBot(choice.botId, choice.providerId, choice.modelId, signal);
        const rest = (await this.store.choices(computerId)).filter(
          (row) => row.botId !== choice.botId,
        );
        await this.store.saveChoices(computerId, rest);
      }
    }
    for (const topic of Object.values(this.state.topics))
      await this.store.saveTopic(computerId, { ...topic, state: "closed" });
    this.patch({ topics: {} });
    const waiting = await pushOffline(this.deps.host.call, this.store, computerId, signal);
    this.patch({ waiting });
    await pullOffline(this.deps.host.call, this.store, this.deps.vault, computerId, signal);
    const issuer = host.devices.find((device) => device.id === computerId)?.publicKey;
    if (issuer)
      await pullRunnerAuthorizations(
        this.deps.host.call,
        this.deps.vault,
        computerId,
        issuer,
        signal,
      );
    await this.load();
  }
  /** Select a model while offline; the local choice takes effect immediately and is queued for bots.update. */
  async selectModel(botId: string, providerId: string, modelId: string) {
    const computerId = this.state.computerId;
    if (!computerId || !this.state.unreachable)
      throw new Error("offline_model_selection_unavailable");
    const model = this.state.manifest?.models.find(
      (row) => row.providerId === providerId && row.modelId === modelId && row.delivered,
    );
    const current = this.state.manifest;
    const bot = current?.bots.find((row) => row.id === botId);
    if (!current || !model || !bot) throw new Error("offline_model_unavailable");
    const before = offlineModelFor(current, bot);
    const choices = (await this.store.choices(computerId)).filter((row) => row.botId !== botId);
    choices.push({
      botId,
      providerId,
      modelId,
      // The conflict check compares against the model this Bot had on the phone before the change.
      baselineProviderId: before?.providerId ?? providerId,
      baselineModelId: before?.modelId ?? bot.modelId ?? modelId,
      changedAt: new Date().toISOString(),
    });
    await this.store.saveChoices(computerId, choices);
    const manifest = {
      ...current,
      bots: current.bots.map((row) =>
        row.id === botId ? { ...row, grantId: model.grantId, modelId } : row,
      ),
    };
    await this.store.saveManifest(computerId, manifest);
    this.patch({ manifest, choices });
    await this.load();
  }
  clearConflict(botId: string) {
    if (!this.state.conflicts.includes(botId)) return;
    this.patch({ conflicts: this.state.conflicts.filter((id) => id !== botId) });
  }
  /** The Bot's current computer topic in the phone's copy (the one its chat page last showed). */
  private async currentTopic(computerId: string, botId: string) {
    const copy = StoredTopicsSchema.safeParse(
      await this.deps.data.get(storeKeys.topics(computerId, "bot", botId)).catch(() => undefined),
    );
    return copy.success ? copy.data.current : undefined;
  }
  /** A message to a Bot while the computer is unreachable; the reply streams into `live`. */
  send(botId: string, text: string) {
    if (this.sending) return Promise.reject(new Error("offline_busy"));
    const pending = this.sendReply(botId, text);
    this.sending = pending;
    const clear = () => {
      if (this.sending === pending) this.sending = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }
  private async sendReply(botId: string, text: string) {
    await this.runnerCleanup?.();
    this.runnerCleanup = undefined;
    const computerId = this.state.computerId;
    const manifest = this.state.manifest;
    const bot = manifest?.bots.find((b) => b.id === botId);
    const model = bot && offlineModelFor(manifest, bot);
    if (!computerId || !bot || !model || !this.canReply(botId) || this.state.live)
      throw new Error("offline_unavailable");
    const snapshot = await this.store.snapshot(computerId, botId);
    const stored = await this.deps.vault.get(computerId, model.grantId);
    if (!snapshot || !stored) throw new Error("offline_unavailable");
    const credential = decodeCredential(stored);
    const redact = offlineRedactor([credential.key, ...Object.values(credential.headers ?? {})]);
    let topic = this.state.topics[botId];
    if (
      topic &&
      (topic.messages.length >= LOCAL_TOPIC_MESSAGES - 1 ||
        (topic.runnerReceipts?.length ?? 0) > 20)
    ) {
      await this.store.saveTopic(computerId, { ...topic, state: "closed" });
      topic = undefined;
    }
    const at = this.now().toISOString();
    const joinTopicId = topic ? undefined : await this.currentTopic(computerId, botId);
    topic ??= {
      id: this.uuid(),
      botId,
      grantId: model.grantId,
      providerId: model.providerId,
      modelId: model.modelId,
      createdAt: at,
      ...(joinTopicId ? { joinTopicId } : {}),
      state: "open",
      messages: [],
      audit: [],
      memory: [],
      egress: [],
    };
    const user: LocalMessage = {
      clientId: this.uuid(),
      role: "user",
      content: truncate(text.trim()),
      status: "done",
      createdAt: at,
    };
    topic = { ...topic, messages: [...topic.messages, user] };
    await this.store.saveTopic(computerId, topic);
    const clientId = this.uuid();
    const controller = new AbortController();
    this.reply = controller;
    this.patch({
      topics: { ...this.state.topics, [botId]: topic },
      live: { botId, topicId: topic.id, clientId, text: "" },
    });
    const records = {
      audit: [...topic.audit],
      memory: [...topic.memory],
      egress: [...topic.egress],
      runnerReceipts: [...(topic.runnerReceipts ?? [])],
    };
    const handler = phoneDataHandler({
      ...this.deps.phone,
      prefs: () => readPhoneDataPrefs(this.deps.data, computerId),
      log: (entry) => appendPhoneDataLog(this.deps.data, computerId, entry),
    });
    const target = snapshot.runner?.boundary.location?.target;
    const current = () =>
      this.state.computerId === computerId &&
      this.deps.host.getSnapshot().devices.some((d) => d.id === computerId) &&
      !controller.signal.aborted;
    const runnerConnection = this.deps.runnerConnection;
    const durableTopic = topic;
    const runner =
      snapshot.runner && target && runnerConnection
        ? new OfflineRunnerTools({
            context: snapshot.runner,
            connect: (signal) => runnerConnection(computerId, target, signal),
            current,
            canStart: () => current() && this.state.unreachable,
            signal: controller.signal,
            redact,
            approve: (card, signal) =>
              this.approveRunner(
                { ...card, command: card.command && redact(card.command) },
                signal,
              ),
            output: (text) => {
              if (current())
                this.patch({ runnerOutput: { botId, text: redact(text).slice(-20000) } });
            },
            record: async (receipt) => {
              if (!this.deps.host.getSnapshot().devices.some((d) => d.id === computerId))
                throw new Error("offline_unpaired");
              const index = records.runnerReceipts.findIndex(
                (r) => r.clientId === receipt.clientId,
              );
              if (index < 0) {
                if (records.runnerReceipts.length >= 32)
                  throw new Error("offline_receipt_capacity");
                records.runnerReceipts.push(receipt);
              } else records.runnerReceipts[index] = receipt;
              const durable = { ...durableTopic, ...records };
              await this.store.saveTopic(computerId, durable);
              if (this.state.computerId === computerId)
                this.patch({ topics: { ...this.state.topics, [botId]: durable } });
            },
          })
        : undefined;
    if (runner) this.runnerCleanup = () => runner.close();
    let result: Awaited<ReturnType<typeof runOfflineReply>>;
    let streamed = "";
    const sealed: string[] = [];
    try {
      result = await runOfflineReply({
        model: portableModel(model),
        apiKey: credential.key,
        ...(credential.headers ? { headers: credential.headers } : {}),
        snapshot,
        history: topic.messages,
        tools: snapshot.tools
          .filter((t) => runner || !(OFFLINE_RUNNER_TOOLS as readonly string[]).includes(t.name))
          .map((t) => t.name),
        canContinue: () => this.state.unreachable && current(),
        signal: controller.signal,
        stream: this.deps.stream,
        run: async (name, args, signal) => {
          const outcome =
            runner && (OFFLINE_RUNNER_TOOLS as readonly string[]).includes(name)
              ? await runner.run(name, args, signal)
              : await runOfflineTool(
                  {
                    handler,
                    canSeeImages: model.input.includes("image"),
                    audit: (entry) => {
                      if (records.audit.length < 200)
                        records.audit.push({
                          ...entry,
                          clientId: this.uuid(),
                          at: this.now().toISOString(),
                        });
                    },
                    propose: (entry) => {
                      if (records.memory.length < 20)
                        records.memory.push({
                          ...entry,
                          clientId: this.uuid(),
                          messageClientId: clientId,
                        });
                    },
                  },
                  name,
                  args,
                  signal,
                );
          return { ...outcome, text: redact(outcome.text) };
        },
        onText: (value) => {
          streamed = [...sealed, redact(value)].filter(Boolean).join("\n\n");
          if (this.state.live?.clientId === clientId)
            this.patch({ live: { ...this.state.live, text: redact(value) } });
        },
        onPart: (value) => {
          sealed.push(redact(value));
          if (this.state.live?.clientId === clientId)
            this.patch({ live: { ...this.state.live, parts: [...sealed], text: "" } });
        },
        onRequest: (messageCount) => {
          const entry = {
            clientId: this.uuid(),
            at: this.now().toISOString(),
            providerId: model.providerId,
            modelId: model.modelId,
            messageCount,
          };
          if (records.egress.length < 200) records.egress.push(entry);
          void this.store.appendLedger(computerId, { ...entry, botId }).catch(() => {
            // The ledger row is a courtesy display; the uploaded egress record is what counts.
          });
        },
      });
    } catch {
      result = {
        status: controller.signal.aborted ? "aborted" : "error",
        text: streamed,
        ...(controller.signal.aborted ? {} : { errorCode: "provider_error" }),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costUsd: 0,
          requests: 0,
        },
        tools: [],
      };
    }
    let cleanupFailed = false;
    try {
      await runner?.close();
      this.runnerCleanup = undefined;
    } catch {
      // Persist the finished turn and retire its UI; the retained owner blocks the next run
      // until cleanup succeeds. Do not erase an execution receipt because transport close failed.
      cleanupFailed = true;
    }
    this.settleApproval?.(false);
    const assistant: LocalMessage = {
      clientId,
      role: "assistant",
      content: truncate(redact(result.text)),
      status: result.status,
      createdAt: this.now().toISOString(),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      usage: result.usage,
      ...(result.tools.length ? { tools: result.tools } : {}),
      ...(result.question ? { question: result.question } : {}),
    };
    // Each model reply is its own message; the last one carries status, usage and question.
    const split = result.parts?.filter((part) => part.text.trim()) ?? [];
    // A topic holds at most LOCAL_TOPIC_MESSAGES; when the parts would not fit, keep one message.
    const parts =
      topic.messages.length + split.length <= LOCAL_TOPIC_MESSAGES ? split : split.slice(-1);
    const earlier: LocalMessage[] =
      parts.length > 1
        ? parts.slice(0, -1).map((part) => ({
            clientId: this.uuid(),
            role: "assistant",
            content: truncate(redact(part.text)),
            status: "done",
            createdAt: this.now().toISOString(),
            ...(part.tools.length ? { tools: part.tools } : {}),
          }))
        : [];
    const last = parts.length > 1 ? parts.at(-1) : undefined;
    // When the parts were collapsed for space, the joined text (result.text) stays the reply.
    const reply: LocalMessage = last
      ? {
          ...assistant,
          content: truncate(redact(last.text)),
          ...(last.tools.length ? { tools: last.tools } : { tools: undefined }),
        }
      : assistant;
    if (!reply.tools) delete reply.tools;
    const finished: LocalTopic = {
      ...topic,
      ...records,
      messages: [...topic.messages, ...earlier, reply],
    };
    await this.store.saveTopic(computerId, finished);
    if (this.reply === controller) this.reply = undefined;
    if (this.state.computerId === computerId)
      this.patch({
        runnerApproval: undefined,
        runnerOutput: undefined,
        topics: { ...this.state.topics, [botId]: finished },
        live: undefined,
        ledger: await this.store.ledger(computerId),
      });
    if (cleanupFailed) throw new Error("offline_runner_cleanup_failed");
    // The computer came back during the reply: hand the topic over now.
    if (this.deps.host.getSnapshot().status === "online") void this.sync();
    return reply;
  }
  respondRunnerApproval(id: string, approved: boolean) {
    if (this.state.runnerApproval?.id === id) this.settleApproval?.(approved);
  }
  private approveRunner(card: RunnerApproval, signal: AbortSignal): Promise<boolean> {
    if (this.settleApproval || signal.aborted || !this.state.unreachable)
      return Promise.resolve(false);
    return new Promise((resolve) => {
      let finished = false;
      const done = (approved: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancelled);
        this.settleApproval = undefined;
        this.patch({ runnerApproval: undefined });
        resolve(approved);
      };
      const cancelled = () => done(false);
      const timer = setTimeout(cancelled, 60000);
      this.settleApproval = done;
      this.patch({ runnerApproval: card });
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
  }
  abort() {
    this.reply?.abort();
  }
}
