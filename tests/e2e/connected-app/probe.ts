import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { receiptChips } from "../../../packages/client-core/src/index.ts";
import { createTranslator } from "../../../packages/i18n/src/index.ts";
import type { Plugin } from "../../../sdk/plugin-sdk/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { fixture, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

type Json = Record<string, unknown>;
const EVENT_TITLE = "合成固定日程";
const FAKE_SANDBOX_HOST = fileURLToPath(new URL("./fake-sandbox-host.mjs", import.meta.url));

const fakeServer = String.raw`
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const tools = [{
  name: "list_events",
  description: "Synthetic bounded calendar read",
  inputSchema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"], additionalProperties: false },
  annotations: { readOnlyHint: true }
}];
const result = { ok: true, items: [{ id: "event-fixed", title: ${JSON.stringify(EVENT_TITLE)}, start: "2030-01-10T09:00:00.000Z", end: "2030-01-10T10:00:00.000Z", allDay: false, calendarId: "calendar-fixed" }], nextCursor: null };
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let response;
  if (request.method === "initialize") response = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pibot-fake-calendar", version: "1" } };
  else if (request.method === "tools/list") response = { tools };
  else if (request.method === "tools/call") {
    await appendFile(process.env.CALLS_FILE, "call:" + JSON.stringify(request.params) + "\n");
    response = { content: [{ type: "text", text: JSON.stringify(result) }] };
  } else if (request.method === "ping") response = {};
  else response = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response }) + "\n");
}
`;

function fakeCalendarPlugin(script: string, calls: string): Plugin {
  const trustedReads = new Set(["list_events"]);
  return {
    id: "calendar",
    version: "1.0.0",
    card: () => ({
      id: "calendar",
      name: { zh: "本机日历", en: "Local calendar" },
      description: { zh: "合成日历", en: "Synthetic calendar" },
      category: "local",
      supported: true,
      unsupportedReason: null,
      modes: [
        {
          id: "system",
          auth: "system",
          capability: { zh: "合成", en: "Synthetic" },
          help: { zh: "合成", en: "Synthetic" },
          documentationUrl: "https://example.com/calendar",
        },
      ],
    }),
    mcp: {
      server: () => ({
        id: "calendar",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        env: { CALLS_FILE: calls },
        auth: { kind: "system", secretNames: [] },
        networkDomains: [],
      }),
      trustedReads,
      defaultEnabled: () => true,
      draftBinding: () => undefined,
      trustedStdio: { hostScriptPath: FAKE_SANDBOX_HOST },
      capability: {
        id: "calendar",
        tools: { list_events: "calendar_list_events" },
        readOnlyTools: trustedReads,
      },
    },
  };
}

function toolNames(body: Json): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const tool = raw as Json;
    const nested = tool.function;
    const name =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Json).name
        : tool.name;
    return typeof name === "string" ? [name] : [];
  });
}

async function done(
  f: Awaited<ReturnType<typeof fixture>>,
  sent: { conversationId?: string; assistantMessageId: string },
) {
  assert(sent.conversationId, "连接应用演练缺少 conversationId");
  const rows = await until(
    "连接应用演练回复终态",
    () =>
      f.client.call("chat.history", {
        botId: f.researcher.id,
        topicId: sent.conversationId,
      }),
    (items) =>
      items.some((item) => item.id === sent.assistantMessageId && item.status !== "streaming"),
  );
  const reply = rows.find((item) => item.id === sent.assistantMessageId);
  assert(reply);
  assert.equal(reply.status, "done");
  return reply;
}

/** Proves the full connected-app authorization path, including one-time consent and receipt. */
export async function runConnectedAppProbe(root: string) {
  const requests: Array<{ tools: string[]; body: string }> = [];
  const script = join(root, "fake-calendar-mcp.mjs");
  const calls = join(root, "fake-calendar-calls.ndjson");
  await writeFile(script, fakeServer, { mode: 0o600 });
  await writeFile(calls, "", { mode: 0o600 });
  const scenario: Scenario = { replies: [{ text: "connected app fallback" }], routes: {} };
  const f = await fixture(
    scenario,
    root,
    {},
    { plugins: [fakeCalendarPlugin(script, calls)] },
    {
      onRequest(body, route) {
        if (route === "researcher")
          requests.push({ tools: toolNames(body), body: JSON.stringify(body) });
      },
    },
  );
  let stage = "连接本机日历";
  try {
    await f.client.call("permissions.set", {
      botId: f.researcher.id,
      levels: { connector: "ask" },
    });
    const connected = await f.client.call("apps.connect", {
      appId: "calendar",
      mode: "system",
      enable: true,
    });
    const connectorId = connected.connectors[0]?.id;
    assert(connectorId, "连接本机日历后应产生 connector");
    const ready = await until(
      "本机日历连接就绪",
      () => f.client.call("connectors.get", { id: connectorId }),
      (value) => !["starting", "disabled"].includes(value.connector.status),
    );
    assert.equal(
      ready.connector.status,
      "ready",
      `本机 MCP 服务启动失败：${ready.connector.statusDetailCode ?? "unknown"}`,
    );
    assert.equal(ready.access.mode, "all");
    await f.client.call("connectors.update", {
      id: connectorId, expectedRevision: ready.connector.revision, confirmationMode: "always_ask",
    });
    await f.client.call("capabilities.set", {
      scope: "bot",
      scopeId: f.researcher.id,
      capabilityId: "calendar",
      impl: `connector:${connectorId}`,
    });

    stage = "触发日历读取";
    scenario.routes = {
      researcher: withToolDiscovery(
        [
          {
            toolCalls: [
              {
                name: "calendar_list_events",
                arguments: {
                  start: "2030-01-10T00:00:00.000Z",
                  end: "2030-01-11T00:00:00.000Z",
                },
              },
            ],
          },
          { text: "connected app complete" },
        ],
        toolLoadGroup,
      ),
    };
    const requestStart = requests.length;
    const sent = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "读取固定日程",
      newTopic: true,
    });
    stage = "等待连接应用审批卡";
    const pending = await until(
      "连接应用等待审批",
      () => f.client.call("approvals.pending", {}),
      (cards) => cards.some((card) => card.runId === sent.runId),
    );
    const cards = pending.filter((card) => card.runId === sent.runId);
    assert.equal(cards.length, 1, "连接应用调用只出现一张审批卡");
    const card = cards[0];
    assert(card);
    assert.equal(card.category, "connector");
    assert.equal(card.connectorConsent, undefined);
    assert.equal(card.canRemember, false);

    stage = "允许一次并等待执行";
    await f.client.call("approvals.resolve", {
      id: card.id,
      decision: "allow",
      remember: false,
    });
    const reply = await done(f, sent);
    assert(reply.runId);
    assert.equal(
      (await f.client.call("connectors.get", { id: connectorId })).access.mode,
      "all",
      "允许一次不能改变连接使用范围",
    );
    const runRequests = requests.slice(requestStart);
    assert(
      runRequests.some((request) => request.tools.includes("calendar_list_events")),
      "授权前工具表应包含日历读取工具",
    );
    assert(
      runRequests.some((request) => request.body.includes(EVENT_TITLE)),
      "允许后固定日程应作为工具结果返回给模型",
    );
    const serviceCalls = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("call:"));
    assert.equal(serviceCalls.length, 1, "本机 MCP 日历只执行一次");

    stage = "核对收据";
    await wait(300);
    const receipt = await f.client.call("runs.receipt", { runId: reply.runId });
    assert.equal(receipt.inputs.connectors.total, 1);
    assert.equal(receipt.approvals.asked, 1);
    assert.equal(receipt.approvals.allowed, 1);
    const chips = receiptChips(receipt, createTranslator("zh")).map((chip) => chip.text);
    assert.deepEqual(
      chips.filter((text) => text === "读取 1 项" || text === "1 次审批"),
      ["读取 1 项", "1 次审批"],
      "收据显示读取 1 项 · 1 次审批",
    );

    stage = "核对最近使用与数据去向";
    // The connection details read the same records; one call is one row.
    const recent = await f.client.call("connectors.recentUse", { id: connectorId, limit: 10 });
    const uses = recent.items.filter((item) => item.runId === reply.runId);
    assert.equal(uses.length, 1, "最近使用应只出现这一次调用一行");
    const use = uses[0];
    assert(use);
    assert.equal(use.botId, f.researcher.id);
    assert.equal(use.kind, "read");
    assert.equal(use.outcome, "done");
    assert.equal(use.tool, "calendar_list_events");
    assert(!JSON.stringify(recent).includes("2030-01-10"), "最近使用不含调用参数");
    const destinations = await f.client.call("connectors.dataDestinations", { id: connectorId });
    assert.deepEqual(
      destinations.items.map((item) => item.destination.kind),
      ["this_computer"],
      "本机日历的数据去向只有这台电脑",
    );
    assert(destinations.items[0]?.lastAt, "数据去向显示最近一次时间");
    assert(destinations.items[0]?.categories.includes("requests"));

    stage = "把连接权限设为从不";
    await f.client.call("permissions.set", {
      botId: f.researcher.id,
      levels: { connector: "never" },
    });
    scenario.routes = { researcher: [{ text: "connector permission never complete" }] };
    const neverStart = requests.length;
    const never = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "验证连接权限从不",
    });
    await done(f, never);
    const neverRequests = requests.slice(neverStart);
    assert(neverRequests.length > 0, "从不权限演练应发起模型请求");
    assert(
      neverRequests.every((request) => !request.tools.includes("calendar_list_events")),
      "连接权限为从不后，日历工具不应出现在工具表",
    );

    return {
      scenario: "连接应用完整授权链",
      status: "脚本化通过",
      approval: { cards: cards.length, category: card.category, consent: "once" },
      tool: { returnedEvents: 1, serviceCalls: 1, hiddenWhenNever: true },
      receipt: { inputs: receipt.inputs.connectors.total, approvals: receipt.approvals.asked },
      recentUse: { rows: uses.length, outcome: use.outcome },
      destinations: destinations.items.map((item) => item.destination.kind),
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } catch (error) {
    console.error(`连接应用演练失败阶段：${stage}`);
    throw error;
  } finally {
    await f.cleanup();
  }
}

/** Production user identity; never change identities in the fixture database. */
export async function runConnectionToolGrantProbe(root: string) {
  const script = join(root, "fake-tool-grant.mjs");
  const calls = join(root, "fake-tool-grant-calls.ndjson");
  await writeFile(
    script,
    fakeServer.replace(
      "const result =",
      `tools.push({ name: "create_event", description: "Synthetic write", inputSchema: {type: "object", properties: {label: {type: "string"}}, required: ["label"], additionalProperties: false} });\nconst result =`,
    ),
  );
  await writeFile(calls, "");
  const scenario: Scenario = { replies: [{ text: "identity fixture fallback" }], routes: {} };
  const f = await fixture(scenario, root, {}, { plugins: [fakeCalendarPlugin(script, calls)] });
  try {
    const connected = await f.client.call("apps.connect", {
      appId: "calendar",
      mode: "system",
      enable: true,
    });
    const id = connected.connectors[0]?.id;
    assert(id);
    await until(
      "synthetic MCP ready",
      () => f.client.call("connectors.get", { id }),
      (row) => row.connector.status === "ready",
    );
    let ready = await until(
      "production identity ready",
      () => f.client.call("connectors.get", { id }),
      (row) => row.connector.status === "ready" || row.connector.status === "idle",
    );
    assert.equal(ready.connector.identity, "user");
    const botTarget = { kind: "bot" as const, id: f.researcher.id };
    const groupTarget = { kind: "group" as const, id: f.group.id };
    const availability = (target: typeof botTarget | typeof groupTarget, tool?: string) =>
      f.client.call("connections.availability", { target, connection: id, tool });
    for (const connection of [
      "------------------------------------",
      "00000000-0000-1000-8000-000000000000",
    ]) {
      const unknown = await f.client.call("connections.availability", {
        target: botTarget,
        connection,
      });
      assert.equal(unknown.connection, "unknown");
      assert.equal(unknown.reason, "not_connected");
    }
    assert.equal((await availability(botTarget, "create_event")).reason, "available");
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      access: { mode: "selected", bots: [f.researcher.id], groups: [] },
    });
    assert.equal((await availability(botTarget)).reason, "available");
    assert.equal(
      (await availability(groupTarget)).reason,
      "no_access",
      "private grants do not follow a Bot into a group",
    );
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      access: { mode: "selected", bots: [], groups: [f.group.id] },
    });
    assert.equal((await availability(botTarget)).reason, "no_access");
    assert.equal((await availability(groupTarget)).reason, "available");
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      access: { mode: "all", bots: [], groups: [] },
      confirmationMode: "read_only",
    });
    assert.equal((await availability(botTarget, "create_event")).reason, "read_only_mode");
    assert.equal((await availability(botTarget, "list_events")).reason, "available");
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      confirmationMode: "read_write",
      tools: [{ tool: "create_event", enabled: false, readOnly: false }],
    });
    assert.equal((await availability(botTarget, "create_event")).reason, "tool_disabled");
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      tools: [{ tool: "create_event", enabled: true, readOnly: false }],
    });
    ready = await f.client.call("connectors.get", { id });
    scenario.routes = {
      researcher: withToolDiscovery(
        Array.from({ length: 8 }, (_, index) => index).flatMap((index) => [
          {
            toolCalls: [
              {
                name: "connector_call",
                arguments: {
                  connectorId: id,
                  catalogVersion: ready.connector.catalogVersion,
                  tool: "create_event",
                  args: { label: `synthetic-${index}` },
                },
              },
            ],
          },
          { text: `write ${index} complete` },
        ]),
        toolLoadGroup,
      ),
    };
    const send = () =>
      f.client.call("chat.send", { botId: f.researcher.id, text: "synthetic write" });
    const pending = (stage = "write draft") =>
      until(
        `identity ${stage}`,
        () => f.client.call("approvals.pending", { botId: f.researcher.id }),
        (items) => items.length > 0,
      );
    // Maintainers 2026-10-31: sending as the user asks every time; the card offers no
    // remembered tool consent and confirming never creates a grant, in chat or in a routine.
    const confirmNext = async (stage: string) => {
      const card = (await pending(stage)).find((item) => item.draft);
      assert(card?.draft);
      assert.equal(card.draft.identity, "user");
      assert.notEqual(card.draft.canRememberTool, true);
      await f.client.call("drafts.resolve", { approvalId: card.id, action: "send" });
      return card;
    };
    const noGrants = async () =>
      assert.equal(
        (await f.client.call("grants.list", { connectorId: id, botId: f.researcher.id, limit: 20 }))
          .length,
        0,
      );
    for (const stage of ["write draft", "second write draft"]) {
      const run = await send();
      await confirmNext(stage);
      await done(f, run);
      await noGrants();
    }
    const routine = await f.client.call("routines.create", {
      botId: f.researcher.id,
      name: "合成账号写入",
      instructions: "只执行脚本指定的合成连接操作",
      triggers: [{ kind: "cron", expr: "0 0 1 1 *", timezone: "UTC" }],
    });
    const routineDone = async (runId: string) => {
      const rows = await until(
        "routine terminal",
        () => f.client.call("routines.runs", { id: routine.id }),
        (rows) =>
          rows.some(
            (row) =>
              row.id === runId && ["done", "failed", "cancelled", "timeout"].includes(row.status),
          ),
      );
      assert.equal(rows.find((row) => row.id === runId)?.status, "done");
    };
    for (const stage of ["routine draft", "second routine draft"]) {
      const run = await f.client.call("routines.runNow", { id: routine.id });
      const card = await confirmNext(stage);
      assert(card.routineRunId);
      await routineDone(run.runId);
      await noGrants();
    }
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      confirmationMode: "always_ask",
    });
    const alwaysAsk = await send();
    // "Ask every time" asks once, on the connection card; that answer sends this one
    // draft, so no second card appears and nothing can be remembered.
    const connectionCard = (await pending("always ask connection")).find((item) => !item.draft);
    assert(connectionCard);
    assert.equal(connectionCard.canRemember, false);
    await f.client.call("approvals.resolve", {
      id: connectionCard.id,
      decision: "allow",
      remember: false,
    });
    await done(f, alwaysAsk);
    assert.equal(
      (await f.client.call("approvals.pending", { botId: f.researcher.id })).filter(
        (item) => item.draft,
      ).length,
      0,
    );
    ready = await f.client.call("connectors.get", { id });
    await f.client.call("connectors.update", {
      id,
      expectedRevision: ready.connector.revision,
      confirmationMode: "read_write",
    });
    for (const stage of ["third write draft", "fourth write draft", "fifth write draft"]) {
      const run = await send();
      await confirmNext(stage);
      await done(f, run);
    }
    await noGrants();
    await f.client.call("routines.setEnabled", { id: routine.id, enabled: false });
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 8);
    // Recent use pages the eight sent writes (newest first) without repeats.
    const firstPage = await f.client.call("connectors.recentUse", { id, limit: 5 });
    assert.equal(firstPage.items.length, 5);
    assert(firstPage.nextCursor, "最近使用超过一页时应有下一页");
    const secondPage = await f.client.call("connectors.recentUse", {
      id,
      before: firstPage.nextCursor,
      limit: 5,
    });
    const writes = [...firstPage.items, ...secondPage.items].filter(
      (item) => item.kind === "write" && item.tool === "create_event",
    );
    assert.equal(writes.length, 8, "最近使用列出全部八次写入");
    assert(writes.every((item) => item.outcome === "done"));
    assert.equal(new Set(writes.map((item) => item.id)).size, 8, "分页不重复");
    const times = [...firstPage.items, ...secondPage.items].map((item) => item.at);
    assert.deepEqual(times, [...times].sort().reverse(), "最近使用按时间倒序");
    const sentTo = await f.client.call("connectors.dataDestinations", { id });
    const local = sentTo.items.find((item) => item.destination.kind === "this_computer");
    assert(local?.categories.includes("written_content"), "数据去向列出写入内容类别");
    const audit = await f.client.call("audit.list", { limit: 200 });
    assert(!audit.some((entry) => entry.kind === "grant.created"));
    assert.equal(f.blocked(), 0);
    return {
      scenario:
        "production user identity asks every send / no remembered grant in chat or routine / always ask",
      status: "scripted passed",
      serviceCalls: 8,
      recentUseWrites: writes.length,
      nonFixtureNetworkAttempts: 0,
    };
  } finally {
    await f.cleanup();
  }
}
