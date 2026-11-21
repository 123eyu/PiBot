import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import {
  acpMethods,
  acpProtocolVersion,
  createAcpClient,
  createAcpNdJsonStream,
} from "../../../packages/acp/src/index.ts";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

const root = resolve(import.meta.dirname, "../../..");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pibot-acp-")));
const dataDir = join(temporary, "data");
const workDir = join(temporary, "workspace");
await mkdir(workDir);
const llm = await startFakeLlm({
  port: 0,
  logDirectory: join(temporary, "http"),
  scenario: {
    replies: withToolDiscovery(
      [
        {
          toolCalls: [
            { name: "run_command", arguments: { command: "printf acp", timeoutSec: 5 } },
          ],
        },
        { text: "ACP 完成" },
        { text: "不应完成", hang: true },
      ],
      toolLoadGroup,
    ),
  },
});
const child = spawn(
  process.execPath,
  [
    "apps/cli/bin/pibot.mjs",
    "acp",
    "--data",
    dataDir,
    "--base-url",
    `${llm.url}/v1`,
    "--model",
    "fake-model",
    "--timeout",
    "60",
  ],
  { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
let approvals = 0;
let terminals = 0;
const updates: string[] = [];
const updateDetails: string[] = [];
const client = createAcpClient({ name: "Pi Bot ACP stdio acceptance" });
client.onRequest(acpMethods.client.session.requestPermission, ({ params }) => {
  approvals++;
  assert(params.toolCall.toolCallId);
  assert(params.toolCall.title);
  assert.match(params.toolCall.title, /editor terminal|编辑器终端/i);
  const allow = params.options.find((option) => option.kind === "allow_once");
  assert(allow);
  return { outcome: { outcome: "selected", optionId: allow.optionId } };
});
client.onRequest(acpMethods.client.terminal.create, ({ params }) => {
  terminals++;
  assert.equal(params.cwd, workDir);
  return { terminalId: `terminal-${terminals}` };
});
client.onRequest(acpMethods.client.terminal.output, () => ({
  output: "acp",
  truncated: false,
  exitStatus: { exitCode: 0 },
}));
client.onRequest(acpMethods.client.terminal.waitForExit, () => ({ exitCode: 0 }));
client.onRequest(acpMethods.client.terminal.release, () => ({}));
client.onRequest(acpMethods.client.terminal.kill, () => ({}));
client.onRequest(acpMethods.client.fs.readTextFile, () => ({ content: "" }));
client.onRequest(acpMethods.client.fs.writeTextFile, () => ({}));
client.onNotification(acpMethods.client.session.update, ({ params }) => {
  updates.push(params.update.sessionUpdate);
  updateDetails.push(JSON.stringify(params.update));
});

const connection = client.connect(
  createAcpNdJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
);
try {
  const initialized = await connection.agent.request(acpMethods.agent.initialize, {
    protocolVersion: acpProtocolVersion,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "acceptance", version: "1" },
  });
  assert.equal(initialized.agentInfo?.name, "Pi Bot");
  const created = await connection.agent.request(acpMethods.agent.session.new, {
    cwd: workDir,
    mcpServers: [],
  });
  assert(created.modes?.availableModes.length);
  const completed = await connection.agent.request(acpMethods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "执行一次命令" }],
  });
  assert.equal(
    completed.stopReason,
    "end_turn",
    JSON.stringify({ approvals, terminals, updates, updateDetails, stderr }),
  );
  assert.equal(approvals, 1, JSON.stringify({ terminals, updates, updateDetails, stderr }));
  assert.equal(terminals, 1, JSON.stringify({ approvals, updates, updateDetails, stderr }));
  assert(
    !updateDetails.some((detail) => JSON.parse(detail).status === "failed"),
    JSON.stringify({ updateDetails, stderr }),
  );
  assert(updates.includes("tool_call"));
  assert(updates.includes("agent_message_chunk"));

  const cancelling = connection.agent.request(acpMethods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "等待取消" }],
  });
  await wait(250);
  await connection.agent.notify(acpMethods.agent.session.cancel, { sessionId: created.sessionId });
  assert.equal((await cancelling).stopReason, "cancelled");
  process.stdout.write("ACP stdio acceptance passed: prompt -> approval -> complete -> cancel\n");
} finally {
  connection.close();
  child.stdin.end();
  const timeout = Symbol("timeout");
  const exited = Promise.race([
    new Promise<number | null>((done) => child.once("exit", done)),
    wait(10_000).then(() => timeout),
  ]);
  const result = await exited;
  if (result === timeout) child.kill("SIGTERM");
  await llm.stop();
  await rm(temporary, { recursive: true, force: true });
  assert.notEqual(
    result,
    timeout,
    `ACP child did not drain after EOF: ${JSON.stringify({ stderr: stderr.slice(-1000), updateDetails })}`,
  );
}
if (child.exitCode && child.exitCode !== 0) throw new Error(`ACP child failed: ${stderr.slice(-1000)}`);
