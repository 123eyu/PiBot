import assert from "node:assert/strict";
import type { PageOptions } from "../../../packages/execution/src/index.ts";
import type { CapabilityItem } from "../../../packages/protocol/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { fixture, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

type Json = Record<string, unknown>;

function names(body: Json): string[] {
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

function item(items: CapabilityItem[], id: CapabilityItem["id"]): CapabilityItem {
  const value = items.find((candidate) => candidate.id === id);
  assert(value, `缺少能力 ${id}`);
  return value;
}

async function stubPage(options: PageOptions) {
  const url = new URL(options.url);
  if (!(await options.allowDomain(url.hostname, options.signal, url.href)))
    throw new Error("tool_plane_domain_denied");
  return {
    url: url.href,
    domain: url.hostname,
    title: "tool plane",
    text: "Synthetic capability selection page",
    truncated: false,
    mimeType: "text/html",
    length: 35,
  };
}

async function disabledConnector(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const manifest = {
    schemaVersion: 1,
    id: "a9.disabled",
    version: "1",
    name: { zh: "已关闭连接", en: "disabled connector" },
    description: { zh: "只验证能力回退", en: "Capability fallback probe only" },
    servers: [
      {
        id: "disabled",
        transport: "stdio",
        command: process.execPath,
        args: ["--version"],
        auth: { kind: "none", secretNames: [] },
        networkDomains: [],
      },
    ],
  };
  const preview = await f.client.call("plugins.previewImport", {
    source: { kind: "json", text: JSON.stringify(manifest) },
  });
  const imported = await f.client.call("plugins.import", {
    previewId: preview.previewId,
    enable: false,
    expectedDigest: preview.digest,
  });
  const id = imported.connectors[0]?.id;
  assert(id);
  const connector = (await f.client.call("connectors.get", { id })).connector;
  assert.equal(connector.enabled, false);
  assert.equal(connector.status, "disabled");
  return id;
}

async function done(
  f: Awaited<ReturnType<typeof fixture>>,
  receipt: { conversationId?: string; assistantMessageId: string },
) {
  assert(receipt.conversationId, "能力选择演练缺少 conversationId");
  return until(
    "能力选择演练回复终态",
    () =>
      f.client.call("chat.history", {
        botId: f.researcher.id,
        topicId: receipt.conversationId,
      }),
    (rows) =>
      rows.some((row) => row.id === receipt.assistantMessageId && row.status !== "streaming"),
  );
}

export async function runCapabilitySelectionProbe(root: string) {
  const captured: string[][] = [];
  const scenario: Scenario = { replies: [{ text: "tool plane fallback" }], routes: {} };
  const f = await fixture(
    scenario,
    root,
    {},
    { pageFetch: stubPage },
    {
      onRequest(body, route) {
        if (route === "researcher") captured.push(names(body));
      },
    },
  );
  const changed: unknown[] = [];
  const unsubscribe = f.client.on("capabilities.changed", (event) => changed.push(event));
  let stage = "创建关闭连接";
  try {
    const connectorId = await disabledConnector(f);
    stage = "验证未映射连接被拒";
    // Only a connection whose current catalog maps the capability can be chosen;
    // this one never published a catalog.
    await assert.rejects(
      f.client.call("capabilities.set", {
        scope: "bot",
        scopeId: f.researcher.id,
        capabilityId: "web.fetch",
        impl: `connector:${connectorId}`,
      }),
      /capability_connector_unmapped/,
    );
    let current = item(
      (await f.client.call("capabilities.list", { botId: f.researcher.id })).items,
      "web.fetch",
    );
    assert.equal(current.impl, "builtin", "未映射连接不改变默认内置实现");
    assert.equal(current.source, "default");
    assert(
      !current.available.some((option) => option.impl === `connector:${connectorId}`),
      "未映射连接不出现在可选实现里",
    );

    stage = "验证三级覆盖";
    await f.client.call("capabilities.set", {
      scope: "global",
      capabilityId: "files.read",
      impl: "off",
    });
    current = item(
      (
        await f.client.call("capabilities.list", {
          botId: f.researcher.id,
          groupId: f.group.id,
        })
      ).items,
      "files.read",
    );
    assert.deepEqual([current.impl, current.source], ["off", "global"]);
    await f.client.call("capabilities.set", {
      scope: "group",
      scopeId: f.group.id,
      capabilityId: "files.read",
      impl: "builtin",
    });
    current = item(
      (
        await f.client.call("capabilities.list", {
          botId: f.researcher.id,
          groupId: f.group.id,
        })
      ).items,
      "files.read",
    );
    assert.deepEqual([current.impl, current.source], ["builtin", "group"]);
    await f.client.call("capabilities.set", {
      scope: "bot",
      scopeId: f.researcher.id,
      capabilityId: "files.read",
      impl: "off",
    });
    current = item(
      (
        await f.client.call("capabilities.list", {
          botId: f.researcher.id,
          groupId: f.group.id,
        })
      ).items,
      "files.read",
    );
    assert.deepEqual([current.impl, current.source], ["off", "bot"]);
    for (const [scope, scopeId] of [
      ["bot", f.researcher.id],
      ["group", f.group.id],
      ["global", undefined],
    ] as const)
      await f.client.call("capabilities.set", {
        scope,
        ...(scopeId ? { scopeId } : {}),
        capabilityId: "files.read",
        impl: null,
      });

    stage = "冻结前设置内置";
    await f.client.call("capabilities.set", {
      scope: "bot",
      scopeId: f.researcher.id,
      capabilityId: "web.fetch",
      impl: "builtin",
    });
    stage = "启动冻结运行";
    scenario.routes = {
      researcher: withToolDiscovery(
        [
          {
            toolCalls: [
              {
                name: "web_fetch",
                arguments: { url: "https://a9.example/frozen" },
              },
            ],
          },
          { text: "frozen run complete" },
        ],
        toolLoadGroup,
      ),
    };
    const beforeFrozen = captured.length;
    const frozen = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "verify frozen capability selection",
      newTopic: true,
    });
    stage = "等待冻结运行审批";
    const pending = await until(
      "web_fetch 等待审批",
      () => f.client.call("approvals.pending", {}),
      (cards) => cards.some((card) => card.category === "web"),
    );
    const approval = pending.find((card) => card.category === "web");
    assert(approval);
    stage = "冻结运行中关闭能力";
    await f.client.call("capabilities.set", {
      scope: "bot",
      scopeId: f.researcher.id,
      capabilityId: "web.fetch",
      impl: "off",
    });
    stage = "批准冻结运行网页读取";
    await f.client.call("approvals.resolve", {
      id: approval.id,
      decision: "allow",
      remember: false,
    });
    stage = "等待冻结运行完成";
    await done(f, frozen);
    const frozenRequests = captured.slice(beforeFrozen);
    assert(frozenRequests.length >= 2, "当前 run 应包含工具调用前后的模型请求");
    assert(
      frozenRequests.every((tools) => tools.includes("web_fetch")),
      "运行中切换不改变当前 run 的工具表",
    );

    stage = "验证下一次运行";
    scenario.routes = { researcher: [{ text: "next run complete" }] };
    const beforeNext = captured.length;
    const next = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "verify next run is off",
      newTopic: true,
    });
    await done(f, next);
    const nextRequests = captured.slice(beforeNext);
    assert(nextRequests.length > 0);
    assert(nextRequests.every((tools) => !tools.includes("web_fetch")));

    stage = "验证权限从不";
    await f.client.call("capabilities.set", {
      scope: "bot",
      scopeId: f.researcher.id,
      capabilityId: "web.fetch",
      impl: "builtin",
    });
    await f.client.call("permissions.set", {
      botId: f.researcher.id,
      levels: { web: "never" },
    });
    current = item(
      (await f.client.call("capabilities.list", { botId: f.researcher.id })).items,
      "web.fetch",
    );
    assert.equal(current.impl, "off");
    const builtin = current.available.find((option) => option.impl === "builtin");
    assert(builtin && !builtin.ready && builtin.reason?.includes("Never"));
    scenario.routes = { researcher: [{ text: "permission run complete" }] };
    const beforePermission = captured.length;
    const permission = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "verify web never",
      newTopic: true,
    });
    await done(f, permission);
    assert(captured.slice(beforePermission).every((tools) => !tools.includes("web_fetch")));

    stage = "验证事件和审计";
    const audit = await f.client.call("audit.list", { botId: f.main.id, limit: 200 });
    const changes = audit.filter((entry) => entry.kind === "capability.changed");
    assert(changes.length >= changed.length && changed.length >= 8, "设置同时发事件并写审计");
    for (const entry of changes) {
      assert(entry.detail.capabilityId);
      assert(entry.detail.capabilityImpl);
      assert.equal(entry.detail.connectorId, undefined, "能力审计不记录连接实例");
    }
    assert.equal(f.blocked(), 0, "演练没有访问假模型以外的网络");
    return {
      scenario: "capability selection",
      connectorUnmappedRefused: true,
      hierarchy: true,
      frozenRun: true,
      permissionNever: true,
      changedEvents: changed.length,
      auditEntries: changes.length,
    };
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    unsubscribe();
    await f.cleanup();
  }
}
