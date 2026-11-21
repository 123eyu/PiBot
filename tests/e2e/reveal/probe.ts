import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedOpenTarget } from "../../../packages/computer/src/actions/open-target.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import { fixture, until } from "../chat/harness.ts";

/** computer-use open_file on a folder must point at reveal_in_folder, not claim "executable". */
async function openFileOnFolder(folder: string) {
  const app = { id: "com.example.viewer", name: "Viewer" };
  try {
    await checkedOpenTarget(
      { driver: { platform: process.platform }, blocked: () => false } as never,
      { scope: { apps: [app] }, grantKey: "probe", signal: AbortSignal.timeout(5000) } as never,
      { kind: "file", app: app.id, path: folder },
    );
  } catch (error) {
    return (error as { detail?: string }).detail;
  }
  return "opened";
}

/**
 * Runs one DM turn with four reveal_in_folder calls: a folder and a file inside the Bot's folder
 * (shown), the folder above it and a link inside that leads there (refused, no card).
 */
export async function runRevealProbe(root: string) {
  const outside = root;
  const scenario: Scenario = {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      researcher: [
        { toolCalls: [{ name: "reveal_in_folder", arguments: { path: "产出" } }] },
        { toolCalls: [{ name: "reveal_in_folder", arguments: { path: "产出/简报.md" } }] },
        { toolCalls: [{ name: "reveal_in_folder", arguments: { path: outside } }] },
        { toolCalls: [{ name: "reveal_in_folder", arguments: { path: "link-out" } }] },
        { text: "REVEAL-PROBE-REPLY 已打开产出文件夹。" },
      ],
    },
  };
  const shown: Array<{ path: string; allowedRoots: string[] }> = [];
  const f = await fixture(scenario, root, {
    revealPath: async (params) => {
      shown.push(params);
    },
  });
  try {
    const output = join(f.root, "产出");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "简报.md"), "# 简报\n");
    await symlink(
      outside,
      join(f.root, "link-out"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const sent = await f.client.call("chat.send", {
      botId: f.researcher.id,
      text: "REVEAL-PROBE-PROMPT 打开产出文件夹",
    });
    let cards = 0;
    const reply = await until(
      "显示文件夹回复终态",
      async () => {
        for (const approval of await f.client.call("approvals.pending", {})) {
          cards++;
          await f.client.call("approvals.resolve", {
            id: approval.id,
            decision: "deny",
            remember: false,
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
    assert(reply?.runId, "回复带运行 ID");
    assert.equal(reply.status, "done");
    const tools = (reply.tools ?? []).filter((tool) => tool.tool === "reveal_in_folder");
    assert.deepEqual(
      tools.map((tool) => tool.status),
      ["done", "done", "blocked", "blocked"],
      "工作位置内显示成功，外部与外链被拒绝",
    );
    assert.equal(cards, 0, "像读取一样：不弹审批卡");
    assert.equal(shown.length, 2, "宿主只收到两次显示");
    assert.deepEqual(
      shown.map((call) => call.path),
      [output, join(output, "简报.md")],
      "宿主收到规范化后的真实路径",
    );
    for (const call of shown) assert.deepEqual(call.allowedRoots, [f.root], "宿主按工作位置根复核");

    const audit = (
      await f.client.call("audit.list", { botId: f.researcher.id, limit: 200 })
    ).filter((entry) => entry.runId === reply.runId);
    const revealed = audit.filter((entry) => entry.kind === "file.revealed");
    const denied = audit.filter(
      (entry) => entry.kind === "policy.denied" && entry.detail.toolName === "reveal_in_folder",
    );
    assert.equal(revealed.length, 2, "每次显示一条审计");
    assert(revealed.every((entry) => entry.detail.path && entry.detail.category === "read_file"));
    assert.equal(denied.length, 2);
    assert(
      denied.every((entry) => entry.detail.reasonCode === "outside_workplace_reveal_denied"),
      "拒绝原因是可读范围外",
    );
    const text = JSON.stringify(audit);
    for (const secret of ["REVEAL-PROBE-PROMPT", "REVEAL-PROBE-REPLY", "synthetic-chat-key-only"])
      assert(!text.includes(secret), `审计不得包含 ${secret}`);

    const hint = await openFileOnFolder(output);
    assert.equal(
      hint,
      "folder_use_reveal_in_folder",
      "open_file 打开文件夹时提示改用 reveal_in_folder",
    );

    return {
      scenario: "在文件夹中显示",
      status: "脚本化通过",
      tools: tools.map((tool) => tool.status),
      hostReveals: shown.length,
      approvalCards: cards,
      audit: { revealed: revealed.length, denied: denied.length },
      openFileOnFolder: hint,
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    await f.cleanup();
  }
}
