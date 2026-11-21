import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { ExecError, type PageOptions } from "../../../packages/execution/src/index.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { fixture, until } from "../chat/harness.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";
import { echoConnector } from "../tool-journal/probe.ts";

const REPLY = "FEWER-APPROVALS-PROBE-REPLY 完成";

/** Same contract as exec's fetchPage, including the per-URL decision through policy. */
async function stubPage(options: PageOptions) {
  const url = new URL(options.url);
  if (!(await options.allowDomain(url.hostname, options.signal, url.href)))
    throw new ExecError("web_blocked", "domain_denied");
  return {
    url: url.href,
    domain: url.hostname,
    title: "probe page",
    text: "fewer approvals synthetic public page",
    truncated: false,
    mimeType: "text/html",
    length: 27,
  };
}

/**
 * One direct-message turn with eleven scripted steps (owner decision 2026-10-23: the in-workplace
 * write runs without a card; the outside write asks once and only for that call). Cards
 * are answered like a user would: web reads "always allow" (remembers reading public pages), the
 * rm and outside-write cards are denied, the connector draft is sent, everything else "allow once".
 */
export async function runFewerApprovalsProbe(root: string) {
  const scenario: Scenario = { replies: [{ text: "未匹配到演练身份。" }], routes: {} };
  const f = await fixture(scenario, root, {}, { pageFetch: stubPage });
  // The shared chat fixture pins writes to "ask" for the older approval scenarios; this probe
  // checks the shipped default (in-workplace writes "always"), so it restores that value.
  await f.client.call("permissions.set", { levels: { write_file: "always" } });
  try {
    execFileSync("git", ["init", "-q"], { cwd: f.root });
    await writeFile(join(f.root, "notes.txt"), "inside\n");
    await writeFile(join(f.root, "old.txt"), "old\n");
    const outside = join(dirname(f.root), "outside-material");
    await mkdir(outside, { recursive: true });
    for (const name of ["a.txt", "b.txt"]) await writeFile(join(outside, name), `${name}\n`);
    const echo = await echoConnector(f);
    const command = (text: string) => ({ name: "run_command", arguments: { command: text } });
    const read = (path: string) => ({ name: "read_file", arguments: { path } });
    const fetch = (url: string) => ({ name: "web_fetch", arguments: { url } });
    const write = (path: string) => ({ name: "write_file", arguments: { path, content: "x\n" } });
    scenario.routes = {
      researcher: withToolDiscovery(
        [
          { toolCalls: [command("git status --short")] },
          { toolCalls: [command("ls -la")] },
          { toolCalls: [read(join(f.root, "notes.txt"))] },
          { toolCalls: [fetch("https://first.example/a")] },
          { toolCalls: [fetch("https://second.example/b")] },
          { toolCalls: [read(join(outside, "a.txt"))] },
          { toolCalls: [read(join(outside, "b.txt"))] },
          { toolCalls: [command("rm old.txt")] },
          { toolCalls: [write(join(f.root, "out.txt"))] },
          { toolCalls: [write(join(outside, "out.txt"))] },
          {
            toolCalls: [
              {
                name: "connector_call",
                arguments: {
                  connectorId: echo.id,
                  catalogVersion: echo.catalogVersion,
                  tool: "echo_write",
                  args: { target: "合成收件人", content: "少等人合成内容" },
                },
              },
            ],
          },
          { text: REPLY },
        ],
        toolLoadGroup,
      ),
    };
    const sent = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "FEWER-APPROVALS-PROBE-PROMPT 执行少等人剧本",
    });
    const seen: string[] = [];
    const reply = await until(
      "少等人剧本回复终态",
      async () => {
        for (const card of await f.client.call("approvals.pending", {})) {
          seen.push(card.draft ? "send_draft" : card.category);
          if (card.draft) {
            assert(sent.conversationId);
            await f.client.call("drafts.resolve", { approvalId: card.id, action: "send" });
            continue;
          }
          // The only write_file card here is the one outside the workplace. It is
          // answered like a careful person would: denied, and one call only by construction.
          const outsideWrite = card.category === "write_file";
          if (outsideWrite) {
            assert.equal(card.risk, "danger", "工作位置外写入是危险级确认");
            assert.equal(card.canRemember, false, "工作位置外写入不能记住");
          }
          await f.client.call("approvals.resolve", {
            id: card.id,
            decision: card.category === "run_command" || outsideWrite ? "deny" : "allow",
            remember: card.category === "web",
          });
        }
        const rows = await f.client.call("chat.history", {
          botId: f.researcher.id,
          topicId: sent.conversationId,
        });
        return rows.find((row) => row.id === sent.assistantMessageId);
      },
      (row) => !!row && row.status !== "streaming",
    );
    assert(reply?.runId);
    assert.equal(reply.status, "done");
    await wait(300);
    const audit = (await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 }))
      .filter((entry) => entry.runId === reply.runId)
      .reverse();
    const pick = (
      kind: string,
      filter: (detail: Record<string, unknown>) => boolean = () => true,
    ) =>
      audit
        .filter((entry) => entry.kind === kind && filter(entry.detail))
        .map((entry) => ({
          tool: entry.detail.toolName,
          category: entry.detail.category,
          reason: entry.detail.reasonCode,
        }));
    const asked = pick("approval.requested");
    const automatic = pick("approval.resolved", (detail) => detail.actor === "automatic");
    const refused = pick("policy.denied");
    const tools: string[] = (reply.tools ?? [])
      .filter((tool) => tool.tool !== "tool_discover")
      .map((tool) => `${tool.tool}:${tool.status}`);

    assert.deepEqual(
      automatic.map((entry) => `${entry.tool}:${entry.reason}`),
      [
        "run_command:readonly_command",
        "run_command:readonly_command",
        "web_fetch:public_web_read",
        "read_file:run_grant_matched",
      ],
      "只读命令、记住后的公开网页、同一外部文件夹的第二次读取自动允许并记审计",
    );
    // Owner decision 2026-10-23: writes inside the workplace default to "always" (checkpointed),
    // so the in-workplace write_file no longer shows a card (one was expected here before).
    assert.deepEqual(
      asked.map((entry) => entry.tool),
      ["web_fetch", "read_file", "run_command", "write_file"],
      "第一次网页、外部文件夹第一次、rm、工作位置外写入仍然问；工作位置内写文件默认不问",
    );
    // The connector send is confirmed on its draft card (the send-draft flow, not approval rows).
    assert.deepEqual(
      seen,
      ["web", "read_file", "run_command", "write_file", "send_draft"],
      "用户看到的卡片：只有有风险的步骤",
    );
    assert(tools.includes("write_file:done"), `工作位置内写文件直接完成 ${JSON.stringify(tools)}`);
    const permissions = await f.client.call("permissions.get", { botId: f.researcher.id });
    assert.equal(permissions.effective?.levels.write_file, "always", "写文件默认总是允许");
    assert(
      audit.some(
        (entry) =>
          entry.kind === "approval.resolved" &&
          entry.detail.category === "write_file" &&
          entry.detail.status === "denied" &&
          entry.detail.remember === false,
      ),
      // The person's denial of the one-time card is what stops the write, and the
      // card offered nothing to remember.
      `工作位置外写入经一次性卡拒绝 ${JSON.stringify(refused)}`,
    );
    const grants = await f.client.call("grants.list", { botId: f.researcher.id });
    assert(
      grants.some((grant) => grant.category === "web" && grant.scope.kind === "web_read"),
      "「一直允许」记住的是读取公开网页",
    );
    // The answer opens nothing beyond this call — no grant, and a denied card
    // must leave the outside folder untouched.
    assert(
      !grants.some((grant) => grant.category === "write_file"),
      `工作位置外写入不生成可复用授权 ${JSON.stringify(grants.map((grant) => grant.category))}`,
    );
    await assert.rejects(
      readFile(join(outside, "out.txt"), "utf8"),
      "拒绝工作位置外写入后文件不存在",
    );
    const recorded = JSON.stringify(audit);
    for (const secret of ["FEWER-APPROVALS-PROBE-PROMPT", "少等人合成内容", "synthetic public page"])
      assert(!recorded.includes(secret), `审计不得包含 ${secret}`);
    return {
      scenario: "少等人",
      status: "脚本化通过",
      tools,
      cards: seen,
      inWorkplaceWrite: "no card (default always)",
      outsideWrite: "one-time card (not rememberable), denied, nothing written",
      automatic,
      refused: refused.map((entry) => `${entry.tool}:${entry.reason}`),
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    await f.cleanup();
  }
}
