// Manual exercise of real repositories/services with a synthetic SDK, never a real provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentError, type AgentRuntime, type OpenSessionOptions } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import type { PolicyResult } from "@pibot/policy";
import {
  capabilityToolGroups,
  capabilityToolSpecs,
  createPeer,
  Events,
  Methods,
} from "@pibot/protocol";
import { RoutineRunsRepo, RoutinesRepo } from "@pibot/routines/store";
import {
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  openDatabase,
  runMigrations,
} from "@pibot/storage";
import { ChatService } from "../../../../packages/brain/src/conversations/chat/chat.ts";
import { createBrainRedactor } from "../../../../packages/brain/src/core/privacy.ts";
import { LocalService } from "../../../../packages/brain/src/local-service.ts";
import { createOrchestrationFactory } from "../../../../packages/orchestration/src/index.ts";

const directory = await mkdtemp("/private/tmp/pibot-bg-drain-");
const db = openDatabase(join(directory, "synthetic.db"));
runMigrations(db, process.argv[2]);
const logger = { info() {}, warn() {}, error() {} } as Logger;
const peer = createPeer(
  { post() {}, onMessage: () => () => {} },
  { methods: Methods, events: Events },
);
const kernelPeer = peer as unknown as ConstructorParameters<typeof ChatService>[3];
const model = {
  provider: "synthetic",
  id: "probe",
  name: "Probe",
  contextWindow: 8192,
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let blocked = false,
  releaseModels: (() => void) | undefined;
const modelWait = new Promise<void>((resolve) => {
  releaseModels = resolve;
});
const sessions = new Map<
  string,
  { started: boolean; aborted: boolean; disposed: boolean; finish(): void }
>();
const runtime = {
  listModels: async () => {
    if (blocked) await modelWait;
    return [model];
  },
  openSession: async (options: OpenSessionOptions) => {
    let rejectPrompt: (error: Error) => void = () => {},
      finishPrompt: () => void = () => {};
    const state = { started: false, aborted: false, disposed: false, finish: () => finishPrompt() };
    sessions.set(options.botId, state);
    return {
      sessionFile: options.sessionFile,
      canAppend: () => true,
      hasPendingInput: () => false,
      append: async () => true,
      prompt: async () => {
        state.started = true;
        return new Promise((resolve, reject) => {
          rejectPrompt = reject;
          finishPrompt = () => resolve({ stopReason: "stop", finalText: "synthetic completion" });
        });
      },
      abort: async () => {
        state.aborted = true;
        await delay(30);
        rejectPrompt(new AgentError("aborted"));
      },
      dispose: () => {
        state.disposed = true;
      },
    };
  },
} as unknown as AgentRuntime;
const redactor = createBrainRedactor();
const orchestration = createOrchestrationFactory();
const local = new LocalService({
  db,
  dataDir: directory,
  platform: "darwin",
  userHome: directory,
  tempDir: directory,
  env: {},
  capabilityTools: { specs: capabilityToolSpecs, groups: capabilityToolGroups },
  orchestration,
  peer,
  logger,
  redactor,
  host: {
    secrets: {
      isAvailable: async () => false,
      encrypt: async () => {
        throw new Error("no secrets in probe");
      },
      decrypt: async () => {
        throw new Error("no secrets in probe");
      },
    },
    env: { detect: async () => [], read: async () => undefined },
  },
});
const chat = new ChatService(
  db,
  directory,
  runtime,
  kernelPeer,
  logger,
  redactor,
  undefined,
  local,
);
const groups = orchestration.createGroups({
  db,
  dataDir: directory,
  chat,
  agent: runtime,
  local,
  peer,
  redactor,
  logger,
  requireCredentials: async () => {},
});
const bots = new BotsRepo(db);
const conversations = new ConversationsRepo(db);
const bot = (name: string, isMain = false) =>
  bots.create({
    name,
    isMain,
    avatarShape: "circle",
    avatarColor: "violet",
    avatarEyes: "marks",
    modelProvider: "synthetic",
    modelId: "probe",
    thinkingLevel: "off",
    systemPrompt: "synthetic",
  });
const first = bot("First", true),
  second = bot("Second"),
  routineBot = bot("Routine");
const topics = [first, second, routineBot].map((value) =>
  conversations.create({ botId: value.id }),
);
const wait = async (condition: () => boolean) => {
  for (let turn = 0; !condition() && turn < 300; turn++) await delay(5);
  assert.ok(condition(), "synthetic operation deadline");
};
try {
  const initial = await chat.send(first.id, "synthetic interactive", [], [], topics[0]?.id);
  await wait(() => sessions.get(first.id)?.started === true);
  const routine = new RoutinesRepo(db).create({
    botId: routineBot.id,
    name: "Synthetic schedule",
    instructions: "Synthetic only",
    triggers: [{ kind: "cron", expr: "*/5 * * * *", timezone: "UTC" }],
  });
  const routineTopic = conversations.get(routine.topicConversationId);
  assert.ok(routineTopic);
  const routineRuns = new RoutineRunsRepo(db);
  const scheduled = routineRuns.enqueue({
    routineId: routine.id,
    botId: routineBot.id,
    triggerId: null,
    reason: "manual",
    scheduledFor: new Date().toISOString(),
    dedupeKey: randomUUID(),
  });
  const trigger = new MessagesRepo(db).create({
    conversationId: routineTopic.id,
    role: "user",
    content: "synthetic trigger",
    status: "done",
  });
  const input = {
    bot: routineBot,
    conversationId: routineTopic.id,
    text: "synthetic scheduled",
    kind: "routine" as const,
    routine: {
      claim: () => !!routineRuns.claim(scheduled.id, randomUUID()),
      settled: async () => {},
    },
  };
  const record = chat.queue.insert(input);
  routineRuns.bindExecution(scheduled.id, record.id, trigger.id);
  chat.queue.publish(record, input);
  await wait(() => sessions.get(routineBot.id)?.started === true);
  const approvalController = new AbortController();
  local.tools.create({
    messageId: record.messageId,
    toolCallId: "synthetic-read",
    tool: "read_file",
    summary: "Synthetic approval",
  });
  const policy: PolicyResult = {
    decision: "ask",
    reason: "synthetic",
    explanation: [{ axis: "grant", code: "confirmation_required", effect: "ask" }],
    risk: "normal",
    facts: [{ kind: "read", value: join(directory, "fixture.txt") }],
    canRemember: false,
  };
  let approvalFinished = false;
  const approval = local.approvals
    .request(
      {
        botId: routineBot.id,
        runId: record.id,
        messageId: record.messageId,
        conversationId: routineTopic.id,
        routineRunId: scheduled.id,
        routineSource: "routine",
        language: "en",
        signal: approvalController.signal,
      },
      { id: "synthetic-read", tool: "read_file", input: { path: join(directory, "fixture.txt") } },
      policy,
      { available: false, reason: "synthetic" },
      async () => policy,
    )
    .then((value) => {
      approvalFinished = true;
      return value;
    });
  blocked = true;
  const preflight = chat.send(second.id, "pending DM", [], [], topics[1]?.id).then(
    () => true,
    () => false,
  );
  const group = groups.create({ name: "Synthetic group", botIds: [first.id, second.id] });
  const sendingGroup = groups.send({ groupId: group.id, text: "pending group" }).then(
    () => true,
    () => false,
  );
  const topic = topics[0];
  assert.ok(topic);
  const addition = chat
    .append({
      botId: first.id,
      topicId: topic.id,
      runId: initial.runId,
      requestId: crypto.randomUUID(),
      text: "pending addition",
      mode: "followUp",
    })
    .then(
      () => true,
      () => false,
    );
  chat.admitInteractive(false);
  groups.admitInteractive(false);
  await Promise.all([chat.drainInteractive(), groups.drainInteractive()]);
  assert.equal(await preflight, false);
  assert.equal(await sendingGroup, false);
  assert.equal(await addition, false);
  assert.equal(chat.queue.repo.get(initial.runId)?.status, "aborted");
  assert.equal(sessions.get(first.id)?.disposed, true);
  assert.equal(chat.queue.repo.get(record.id)?.status, "running");
  assert.equal(sessions.get(routineBot.id)?.aborted, false);
  assert.equal(approvalFinished, false);
  assert.equal(local.approvals.repo.blocksTaskCompletion(record.id), true);
  assert.equal(typeof routineRuns.get(scheduled.id)?.ownerToken, "string");
  approvalController.abort();
  await approval;
  assert.throws(() => groups.active(group.id));
  blocked = false;
  releaseModels?.();
  chat.admitInteractive(true);
  groups.admitInteractive(true);
  assert.equal(groups.active(group.id).id, group.id);
  const again = await chat.send(second.id, "reconnected DM", [], [], topics[1]?.id);
  await wait(() => sessions.get(second.id)?.started === true);
  sessions.get(second.id)?.finish();
  await wait(() => chat.queue.repo.get(again.runId)?.status === "done");
  const groupAgain = await groups.send({ groupId: group.id, text: "reconnected group" });
  await wait(
    () => sessions.get(first.id)?.started === true && sessions.get(first.id)?.aborted === false,
  );
  sessions.get(first.id)?.finish();
  await wait(() => chat.queue.repo.get(groupAgain.runId)?.status === "done");
  assert.equal(chat.queue.repo.get(record.id)?.status, "running");
  console.log(
    JSON.stringify(
      {
        passed: 6,
        checks: [
          "DM preflight cancelled",
          "group preflight cancelled",
          "append preflight cancelled",
          "SDK disposal drained while scheduled run survived",
          "offline routine approval remained pending with its owner token",
          "reconnected DM and group both accepted and finished",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  blocked = false;
  releaseModels?.();
  await groups.stop();
  await chat.stop();
  local.cancel();
  await local.dispose();
  peer.dispose();
  db.close();
  await rm(directory, { recursive: true, force: true });
}
