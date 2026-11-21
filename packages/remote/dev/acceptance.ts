// Manual integration exercise: actual brain, fake LLM, real link and local Wrangler.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import type { SocketConstructor } from "@pibot/link";
import {
  capabilityToolGroups,
  capabilityToolSpecs,
  createPeer,
  Events,
  Methods,
  type Port,
} from "@pibot/protocol";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { toolLoadGroup } from "../../brain/src/runtime/tools/tool-catalog.ts";
import { startBrain } from "../../brain-app/src/index.ts";
import { createRemoteLink } from "../src/brain/link/adapter.ts";
import { pairPhone } from "./phone.ts";
import { startRelay } from "./relay.ts";
import { memoryPorts } from "./transport/memory.ts";

async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await wait(30);
  }
  throw new Error("acceptance_wait_timeout");
}
async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-remote-real-")));
  const relay = await startRelay(root);
  const origin = relay.base;
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined;
  let model: Awaited<ReturnType<typeof startFakeLlm>> | undefined;
  let phone: Awaited<ReturnType<typeof pairPhone>> | undefined;
  let session: Awaited<ReturnType<NonNullable<typeof phone>["connect"]>> | undefined;
  const [a, b] = (() => {
    const p = memoryPorts();
    return [p.a, p.b];
  })();
  const desktop = createPeer(b as Port, { methods: Methods, events: Events });
  const lifetime = new AbortController();
  let stage = "relay";
  try {
    stage = "brain";
    model = await startFakeLlm({
      port: 0,
      logDirectory: join(root, "llm"),
      scenario: {
        replies: withToolDiscovery(
          [
            { text: "Streaming remote reply." },
            {
              toolCalls: [
                {
                  name: "write_file",
                  arguments: { path: "approved.txt", content: "synthetic-approved" },
                },
              ],
            },
            { text: "Approved write finished." },
            { text: "This run must be stopped.", delayMs: 300, hang: true },
          ],
          (name) =>
            toolLoadGroup(name, { specs: capabilityToolSpecs, groups: capabilityToolGroups }),
        ),
      },
    });
    const Native = WebSocket;
    const Socket: SocketConstructor = class extends Native {
      constructor(url: string) {
        super(url.replace("wss://relay.invalid", origin.replace(/^http/, "ws")));
      }
    };
    const network = {
      WebSocket: Socket,
      fetch: ((input, init) =>
        globalThis.fetch(
          String(input).replace("https://relay.invalid", origin),
          init,
        )) as typeof fetch,
    };
    brain = await startBrain({
      port: a as Port,
      dataDir: join(root, "data"),
      version: "a8-remote-acceptance",
      platform: process.platform,
      dev: true,
      remote: { link: createRemoteLink(network) },
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
      },
    });
    const bot = (await desktop.call("bots.list", {})).find((v) => v.isMain);
    assert(bot);
    const provider = await desktop.call("customProviders.upsert", {
      name: "Remote fake model",
      baseUrl: `${model.url}/v1`,
      api: "openai-completions",
      apiKey: "synthetic-only",
      models: [{ id: "remote", contextWindow: 32768, maxTokens: 1024 }],
    });
    await desktop.call("bots.update", {
      botId: bot.id,
      modelProvider: provider.id,
      modelId: "remote",
      thinkingLevel: "off",
      permissionOverrides: { write_file: "ask" },
    });
    const folders = await desktop.call("workplaces.add", { botId: bot.id });
    const folder = folders.folders.find((v) => v.path === root);
    assert(folder);
    await desktop.call("workplaces.setCurrent", { botId: bot.id, folderId: folder.id });
    await desktop.call("remote.settings.set", {
      expectedVersion: 0,
      disclosureAccepted: true,
      patch: { enabled: true, relay: "custom", relayUrl: "wss://relay.invalid" },
    });
    stage = "pair";
    const pairing = await desktop.call("devices.pairStart", undefined);
    phone = await pairPhone(
      pairing.payload,
      network,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
    );
    const status = await until(
      () => desktop.call("devices.pairStatus", { id: pairing.id }),
      (v) => v.status === "paired",
    );
    assert(status.deviceId);
    session = await phone.connect(AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]));
    await wait(50);
    const client = session.peer;
    assert((await client.call("bots.list", {})).some((v) => v.id === bot.id));
    console.log("PASS real pairing + list bots");
    stage = "stream";
    let deltas = 0;
    client.on("chat.delta", () => deltas++);
    const first = await client.call("chat.send", {
      botId: bot.id,
      text: "Synthetic streaming request",
      clientMessageId: randomUUID(),
    });
    await until(
      () => client.call("chat.runs", { botId: bot.id }),
      (rows) => rows.some((v) => v.id === first.runId && v.status === "done"),
    );
    assert(deltas > 0);
    console.log("PASS streamed reply");
    stage = "approval";
    await client.call("remote.session.update", {
      foreground: false,
      language: "zh",
      pushToken: "ExpoPushToken[synthetic]",
    });
    const second = await client.call("chat.send", {
      botId: bot.id,
      text: "Synthetic write requiring approval",
      clientMessageId: randomUUID(),
    });
    const approvals = await until(
      () => client.call("approvals.pending", { botId: bot.id }),
      (rows) => rows.length > 0,
    );
    const approval = approvals[0];
    assert(approval);
    await client.call("approvals.resolve", { id: approval.id, decision: "allow", remember: false });
    await until(
      () => client.call("chat.runs", { botId: bot.id }),
      (rows) => rows.some((v) => v.id === second.runId && v.status === "done"),
    );
    assert.equal(await readFile(join(root, "approved.txt"), "utf8"), "synthetic-approved");
    console.log("PASS real approval + permitted write");
    await until(
      async () => relay.pushes,
      (values) => values.length >= 2,
    );
    const notifications = relay.pushes as { data: { route: string }; body: string }[];
    assert(notifications.every((p) => !JSON.stringify(p).includes("synthetic-approved")));
    assert(notifications.some((p) => phone?.openRoute(p.data.route).includes(approval.id)));
    console.log("PASS relay /push to fake Expo; encrypted route, generic body");
    stage = "abort";
    const third = await client.call("chat.send", {
      botId: bot.id,
      text: "Synthetic run to stop",
      clientMessageId: randomUUID(),
    });
    await until(
      () => client.call("chat.runs", { botId: bot.id }),
      (rows) => rows.some((v) => v.status === "running"),
    );
    await client.call("chat.abort", { runId: third.runId });
    await until(
      () => client.call("chat.runs", { botId: bot.id }),
      (rows) => rows.some((v) => v.status === "aborted"),
    );
    console.log("PASS abort running task");
    stage = "deny";
    await assert.rejects(client.call("settings.set", { language: "en" }));
    const db = new DatabaseSync(join(root, "data", "pibot.db"), { readOnly: true });
    try {
      const audits = db.prepare("SELECT detail FROM audit_log WHERE kind='remote.request'").all();
      assert(
        audits.some((row) => {
          const d = JSON.parse(String(row.detail));
          return d.deviceId === status.deviceId && d.reasonCode === "refused";
        }),
      );
    } finally {
      db.close();
    }
    console.log("PASS whitelist denial + device audit");
    stage = "revoke";
    await desktop.call("devices.revoke", { id: status.deviceId });
    assert(
      session.signal.aborted ||
        (await desktop.call("remote.status", undefined)).onlineDevices === 0,
    );
    await session.close();
    session = undefined;
    await assert.rejects(
      phone.connect(AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)])),
    );
    console.log(
      "PASS old phone cannot authenticate/reach RPC after revoke (empty old relay room allowed)",
    );
  } catch (error) {
    console.error("FAILED stage", stage);
    throw error;
  } finally {
    lifetime.abort();
    const closed = await Promise.allSettled([session?.close()]);
    phone?.dispose();
    closed.push(...(await Promise.allSettled([brain?.stop()])));
    desktop.dispose();
    closed.push(...(await Promise.allSettled([model?.stop(), relay.close()])));
    if (closed.some((value) => value.status === "rejected")) {
      console.error("acceptance_drain_failed_root_retained");
      process.exitCode = 1;
    } else await rm(root, { recursive: true, force: true });
  }
}
await main();
