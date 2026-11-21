import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { startFakeLlm } from "../fake-llm/index.ts";
import { loadScenario } from "../fake-llm/scenario.ts";
import { Data } from "./data.mts";
import { startSite } from "./fixtures/site-server.mjs";
import { cleanEnv, confirmWriterExit, launch, noSecrets, stopChild, until } from "./util.mts";

export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), "pbe-self-"));
  let assertions = 0;
  const check = (value: unknown) => {
    assert(value);
    assertions++;
  };
  try {
    const databasePath = join(root, "pibot.db");
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(
        "CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES(1,'public')",
      );
    } finally {
      writer.close();
    }
    const bytes = await readFile(databasePath);
    const data = new Data(root);
    check(data.one("SELECT value FROM fixture WHERE id=? LIMIT 1", 1)?.value === "public");
    check(data.rows("SELECT id FROM fixture WHERE id=? LIMIT 1", 2).length === 0);
    assert.throws(() => data.rows("INSERT INTO fixture VALUES(2,'wrong')"), /read_query_required/);
    check(true);
    assert.throws(() => data.rows("SELECT 1; DELETE FROM fixture"));
    check(true);
    check(bytes.equals(await readFile(databasePath)));
    const log = join(root, "owned-process.log");
    const owned = launch(
      process.execPath,
      ["-e", "console.log('ready'); console.error('stderr-ready'); setInterval(()=>{},1000)"],
      cleanEnv(),
      root,
      log,
    ).child;
    try {
      await until(
        "owned_log",
        () => readFile(log, "utf8"),
        (text) => text.includes("stderr-ready"),
        AbortSignal.timeout(3000),
      );
      check(Number.isInteger(owned.pid));
      await assert.rejects(confirmWriterExit([owned.pid as number], 10), /writer_exit_unconfirmed/);
      check(true);
      await stopChild(owned);
      await confirmWriterExit([owned.pid as number]);
      check(true);
      check((await readFile(log, "utf8")).includes("ready"));
    } finally {
      await stopChild(owned);
    }
    for (const kind of ["login", "teach"]) {
      const site = await startSite(kind, 0, "self-test-token");
      try {
        const html = await fetch(site.url, {
          signal: AbortSignal.timeout(2000),
        }).then((r) => r.text());
        check(html.includes('type="password"'));
        check((await fetch(`${site.url}/__receipt`)).status === 403);
        if (kind === "login") {
          const response = await fetch(`${site.url}/login`, {
            method: "POST",
            body: new URLSearchParams({
              username: "fixture-user",
              password: "synthetic-secret",
            }),
          });
          check((await response.text()).includes("已登录：fixture-user"));
          const receipt = await fetch(`${site.url}/__receipt`, {
            headers: { authorization: "Bearer self-test-token" },
          }).then((r) => r.json());
          check(
            receipt[0].password === "synthetic-secret" && receipt[0].username === "fixture-user",
          );
          check(
            (
              await fetch(`${site.url}/login`, {
                method: "POST",
                body: "a".repeat(5000),
              })
            ).status === 400,
          );
        } else
          check(
            html.includes('id="first"') &&
              html.includes('id="second"') &&
              html.includes('id="note"'),
          );
      } finally {
        await site.stop();
      }
    }
    const receipt = join(root, "mcp.jsonl");
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "fixtures", "mcp-echo", "server.mjs"), receipt],
      { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: child.stdout });
    let next = 0;
    const pending = new Map<
      number,
      {
        resolve(value: Record<string, unknown>): void;
        reject(error: Error): void;
      }
    >();
    lines.on("line", (line) => {
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    });
    child.on("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
    });
    child.on("exit", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("mcp_fixture_exited"));
    });
    const call = (method: string, params = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("mcp_fixture_timeout"));
        }, 3000);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      check(
        !!(
          await call("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "e2e-self", version: "1" },
          })
        ).result,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      check(JSON.stringify((await call("tools/list")).result).includes("echo_read"));
      for (const name of ["echo_read", "echo_write"])
        check(
          !!(
            await call("tools/call", {
              name,
              arguments: { target: "E2E recipient", content: "E2E payload" },
            })
          ).result,
        );
      check(!!(await call("unknown")).error);
      check((await readFile(receipt, "utf8")).trim().split("\n").length === 2);
    } finally {
      child.stdin.end();
      lines.close();
      await stopChild(child);
    }
    for (const name of [
      "browser-login",
      "teach-once",
      "routine-run",
      "connector-mcp",
      "approval-yolo",
      "compact-manual",
    ]) {
      const scenario = await loadScenario(`e2e-${name}`);
      let seen = 0;
      const llm = await startFakeLlm({
        port: 0,
        scenario,
        logDirectory: join(root, name),
        observe: () => seen++,
      });
      try {
        for (const reply of scenario.replies) {
          const response = await fetch(`${llm.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "fake-model",
              messages: [{ role: "user", content: "synthetic request" }],
              stream: false,
            }),
            signal: AbortSignal.timeout(3000),
          });
          check(response.ok);
          const json = await response.json();
          if (reply.toolCalls)
            check(json.choices[0].message.tool_calls[0].function.name === reply.toolCalls[0]?.name);
          else check(json.choices[0].message.content === reply.text);
        }
        check(seen === scenario.replies.length);
        // Exercise the streaming wire too; the consumed scenario correctly reaches its default reply.
        const stream = await fetch(`${llm.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [], stream: true }),
          signal: AbortSignal.timeout(3000),
        });
        check((await stream.text()).includes("[DONE]"));
      } finally {
        await llm.stop();
      }
    }
    // Model settings tests first; fixture replies must be inserted after the consumed prefix.
    const staged = await loadScenario("e2e-routine-run");
    staged.replies = [{ text: "setup-ok" }, { text: "flow-result" }];
    let consumed = 0;
    const stagedLlm = await startFakeLlm({
      port: 0,
      scenario: staged,
      logDirectory: join(root, "staged"),
      observe: () => consumed++,
    });
    const nextReply = async () => {
      const response = await fetch(`${stagedLlm.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fake-model", messages: [], stream: false }),
        signal: AbortSignal.timeout(3000),
      });
      return (await response.json()).choices[0].message.content;
    };
    try {
      check((await nextReply()) === "setup-ok");
      staged.replies.splice(consumed, 0, { text: "owned-fixture" });
      check((await nextReply()) === "owned-fixture");
      check((await nextReply()) === "flow-result");
      check(consumed === 3);
    } finally {
      await stagedLlm.stop();
    }
    const control = join(root, "positive-control");
    await writeFile(control, "privacy-positive-control");
    await assert.rejects(noSecrets(root, ["privacy-positive-control"]));
    assertions++;
    await rm(control);
    check((await noSecrets(root, ["privacy-positive-control"])) > 0);
    console.log(
      JSON.stringify({
        suite: "e2e-node-self-test",
        ok: true,
        assertions,
        window: "not_run",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
