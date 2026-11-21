// Development harness for the phone-data probe (apps/mobile `probe --phone-data`): a real
// brain (brain-app capabilities, policy, tool runner, audit) on a temporary data directory, a
// scripted local model that calls the phone tools, and the real remote capability whose phone
// session runs over the in-memory development link. No relay, encryption, keychain or network.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import {
  capabilityToolGroups,
  capabilityToolSpecs,
  createPeer,
  Events,
  Methods,
  type Port,
} from "@pibot/protocol";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import type { Reply } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { toolLoadGroup } from "../../brain/src/runtime/tools/tool-catalog.ts";
import { startBrain } from "../../brain-app/src/index.ts";
import { createMemoryRemoteLink, memoryPorts } from "./transport/memory.ts";

async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await wait(25);
  }
  throw new Error("phone_data_probe_wait_timeout");
}
/** What the scripted model was sent: the tool results it saw, as raw message JSON. */
export interface ModelTurn {
  tools: string[];
  body: string;
}

export async function startPhoneDataDesktop(script: Reply[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-phone-data-probe-")));
  const dataDir = join(root, "data");
  const turns: ModelTurn[] = [];
  const model = await startFakeLlm({
    port: 0,
    logDirectory: join(root, "llm"),
    scenario: {
      replies: withToolDiscovery(script, (name) =>
        toolLoadGroup(name, { specs: capabilityToolSpecs, groups: capabilityToolGroups }),
      ),
    },
    observe(body) {
      const tools = Array.isArray(body.tools)
        ? body.tools.map((tool) =>
            String((tool as { function?: { name?: unknown } }).function?.name),
          )
        : [];
      turns.push({ tools, body: JSON.stringify(body.messages ?? []) });
    },
  });
  const memory = createMemoryRemoteLink();
  const wire = memoryPorts();
  const brain = await startBrain({
    port: wire.a as Port,
    dataDir,
    version: "a8-phone-data-probe",
    platform: process.platform,
    dev: true,
    remote: { link: memory.link },
    host: {
      secrets: {
        isAvailable: async () => true,
        encrypt: async (plain) => Buffer.from(plain),
        decrypt: async (bytes) => Buffer.from(bytes).toString(),
      },
      env: {
        detect: async () => [],
        read: async () => {
          throw Error("no_host_credentials");
        },
      },
      pickFolder: async () => root,
      // Stands in for the desktop's image toolkit (Electron nativeImage) so phone images can be
      // attached: the probe's JPEGs are already small, kept as they are.
      attachments: {
        image: async (image) => ({ image, width: 640, height: 480 }),
        pdf: async () => {
          throw new Error("probe_pdf_unavailable");
        },
        open: async () => undefined,
      },
    },
  });
  const desktop = createPeer(wire.b as Port, { methods: Methods, events: Events });
  const bot = (await desktop.call("bots.list", {})).find((v) => v.isMain);
  if (!bot) throw new Error("phone_data_probe_main_bot_missing");
  const provider = await desktop.call("customProviders.upsert", {
    name: "Phone data fake model",
    baseUrl: `${model.url}/v1`,
    api: "openai-completions",
    apiKey: "synthetic-only",
    models: [{ id: "phone", contextWindow: 65536, maxTokens: 1024, input: ["text", "image"] }],
  });
  await desktop.call("bots.update", {
    botId: bot.id,
    modelProvider: provider.id,
    modelId: "phone",
    thinkingLevel: "off",
  });
  await desktop.call("remote.settings.set", {
    expectedVersion: 0,
    disclosureAccepted: true,
    patch: { enabled: true },
  });
  const pairing = await desktop.call("devices.pairStart", undefined);
  const publicKey = `development-phone-${randomUUID()}`;
  const [pending] = await until(memory.pendingPairings, (ids) => ids.length > 0);
  memory.completePair(pending as string, {
    publicKey,
    name: "Probe phone",
    room: `development-room-${randomUUID()}`,
    roomSecret: `development-room-secret-${randomUUID()}`,
    securityCode: "123456",
  });
  const status = await until(
    () => desktop.call("devices.pairStatus", { id: pairing.id }),
    (v) => v.status === "paired",
  );
  // A second connection only reads; the brain owns every write.
  const db = new DatabaseSync(join(dataDir, "pibot.db"), { readOnly: true });
  const desktopId = String(
    (db.prepare("SELECT desktop_id FROM remote_settings").get() as { desktop_id: string })
      .desktop_id,
  );
  const phonePort = await until(
    () => {
      try {
        return memory.phone(publicKey);
      } catch {
        return undefined;
      }
    },
    (port) => !!port,
  );
  return {
    botId: bot.id,
    desktopId,
    deviceId: status.deviceId as string,
    desktop,
    turns,
    db,
    /** The phone end of the live session (the desktop already treats the phone as online). */
    phonePort: phonePort as Port,
    disconnectPhone: () => memory.disconnectPhone(publicKey),
    reconnectPhone: () => memory.phone(publicKey),
    async chat(text: string) {
      const sent = await desktop.call("chat.send", { botId: bot.id, text });
      await until(
        () => desktop.call("chat.runs", { botId: bot.id }),
        (rows) =>
          rows.some((v) => v.id === sent.runId && v.status !== "running" && v.status !== "queued"),
        60_000,
      );
      return sent;
    },
    async settled() {
      await until(
        () => desktop.call("chat.runs", { botId: bot.id }),
        (rows) => rows.every((v) => v.status !== "running" && v.status !== "queued"),
        60_000,
      );
    },
    async stop() {
      desktop.dispose();
      await brain.stop();
      db.close();
      await model.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type PhoneDataDesktop = Awaited<ReturnType<typeof startPhoneDataDesktop>>;
