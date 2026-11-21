// End-to-end probe for the extension: a separate Chrome profile loads dist/chrome over a CDP pipe,
// a fake native-messaging host relays frames to this script, and every method is called through
// the real native-messaging channel with its result checked against the contract.
// Run from the repository root: node --import ./tools/dev/ts-hooks.mjs apps/browser-extension/scripts/probe.ts
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionMethods } from "../../../packages/browser-contract/src/api/extension.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST_NAME = "com.pibot.browser";
const extensionDir = resolve(import.meta.dirname, "../dist/chrome");
/** Chrome derives an unpacked extension's id from its manifest key: sha256 of the key, a–p. */
const { key } = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")) as {
  key: string;
};
const expectedId = [
  ...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32),
]
  .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join("");
const work = mkdtempSync(join(process.env.PROBE_TMP ?? tmpdir(), "pibot-ext-"));
const profile = join(work, "profile");
const socketPath = join(work, "host.sock");
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const pages: Record<string, string> = {
  "/user": "<title>user tab</title><h1>user</h1>",
  "/one": `<title>one</title><h1>Page one</h1>
<button id="go" onclick="document.title='clicked'">Go</button>
<input aria-label="Name" id="name">
<select aria-label="Choice" id="choice"><option value="a">A</option><option value="b">B</option></select>
<a href="/two">Next page</a><div style="height:3000px">tall</div>`,
  "/two": "<title>two</title><h1>Page two</h1>",
};
const http = createHttp((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(pages[request.url ?? ""] ?? "<title>missing</title>");
});
await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
const address = http.address();
if (!address || typeof address === "string") throw new Error("no http address");
const base = `http://127.0.0.1:${address.port}`;

// The fake host: Chrome frames (4-byte little-endian length + JSON) <-> one JSON line per message.
const hostScript = join(work, "host.mjs");
writeFileSync(
  hostScript,
  `#!${process.execPath}
import { connect } from "node:net";
const socket = connect(${JSON.stringify(socketPath)});
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32LE(0);
    if (input.length < 4 + size) break;
    socket.write(input.subarray(4, 4 + size).toString("utf8") + "\\n");
    input = input.subarray(4 + size);
  }
});
let pending = "";
socket.on("data", (chunk) => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf("\\n")) >= 0) {
    const body = Buffer.from(pending.slice(0, at), "utf8");
    pending = pending.slice(at + 1);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
`,
);
chmodSync(hostScript, 0o755);

let host: Socket | undefined;
const waiting = new Map<string, (message: Record<string, unknown>) => void>();
const events: Record<string, unknown>[] = [];
let hostReady: () => void = () => {};
const connected = new Promise<void>((done) => {
  hostReady = done;
});
const hostServer = createSocketServer((socket) => {
  host = socket;
  hostReady();
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at >= 0) {
      const message = JSON.parse(pending.slice(0, at)) as Record<string, unknown>;
      pending = pending.slice(at + 1);
      if (typeof message.id === "string" && waiting.has(message.id)) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      } else events.push(message);
      at = pending.indexOf("\n");
    }
  });
});
await new Promise<void>((done) => hostServer.listen(socketPath, done));

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function call(method: string, params: Record<string, unknown>) {
  if (!host) throw new Error("native host not connected");
  const id = randomUUID();
  const reply = new Promise<Record<string, unknown>>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 20_000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      done(message);
    });
  });
  host.write(`${JSON.stringify({ id, method, params })}\n`);
  return reply;
}
/** Calls `method` and checks the result against the host.browser result schema. */
async function check(method: keyof typeof ExtensionMethods, params: Record<string, unknown>) {
  try {
    const reply = await call(method, params);
    if (reply.error) {
      record(method, false, JSON.stringify(reply.error));
      return undefined;
    }
    const parsed = ExtensionMethods[method].result.safeParse(reply.result);
    record(
      method,
      parsed.success,
      parsed.success
        ? ""
        : parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
            .slice(0, 300),
    );
    return reply.result as Record<string, unknown>;
  } catch (error) {
    record(method, false, String(error));
    return undefined;
  }
}

mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1000,700",
    `${base}/user`,
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const cdpOut = chrome.stdio[3] as NodeJS.WritableStream;
const cdpIn = chrome.stdio[4] as NodeJS.ReadableStream;
let cdpId = 0;
let cdpBuffer = "";
const cdpWaiting = new Map<number, (message: Record<string, unknown>) => void>();
cdpIn.on("data", (chunk: Buffer) => {
  cdpBuffer += chunk;
  let at = cdpBuffer.indexOf("\0");
  while (at >= 0) {
    const message = JSON.parse(cdpBuffer.slice(0, at)) as Record<string, unknown>;
    cdpBuffer = cdpBuffer.slice(at + 1);
    const id = message.id as number | undefined;
    if (id !== undefined) cdpWaiting.get(id)?.(message);
    else if (
      process.env.PROBE_DEBUG &&
      (message.method === "Runtime.exceptionThrown" ||
        message.method === "Runtime.consoleAPICalled")
    )
      console.log("[worker]", JSON.stringify(message.params).slice(0, 400));
    at = cdpBuffer.indexOf("\0");
  }
});
function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
  const id = ++cdpId;
  return new Promise<Record<string, unknown>>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 30_000);
    cdpWaiting.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) fail(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else done(message.result as Record<string, unknown>);
    });
    cdpOut.write(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
    );
  });
}

try {
  await wait(2500);
  // The host manifest exists before the extension installs, so onInstalled connects (hello).
  writeFileSync(
    join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`),
    JSON.stringify({
      name: HOST_NAME,
      description: "Pi Bot probe host",
      path: hostScript,
      type: "stdio",
      allowed_origins: [`chrome-extension://${expectedId}/`],
    }),
  );
  const { id: extensionId } = (await cdp("Extensions.loadUnpacked", { path: extensionDir })) as {
    id: string;
  };
  record("extension id from key", extensionId === expectedId, `${extensionId} vs ${expectedId}`);
  await wait(1000);
  const { targetInfos } = (await cdp("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const worker = targetInfos.find(
    (t) => t.type === "service_worker" && t.url.includes(extensionId),
  );
  if (!worker) throw new Error("extension service worker not found");
  const { sessionId } = (await cdp("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  })) as { sessionId: string };
  const evaluate = async (expression: string) =>
    (
      (await cdp(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as { result: { value?: unknown } }
    ).result.value;
  const userWindow = await evaluate("chrome.windows.getLastFocused().then((w) => w.id)");
  await cdp("Runtime.enable", {}, sessionId);
  await Promise.race([connected, wait(15_000)]);
  await wait(1000);
  record(
    "native connection + hello",
    events.some((e) => e.event === "hello"),
    JSON.stringify(events[0] ?? {}),
  );

  const botId = randomUUID();
  const opened = await check("open", { botId, botName: "小媒", url: `${base}/one` });
  const tab = (opened as { page?: { tab?: string } } | undefined)?.page?.tab;
  const snapshot = (await check("snapshot", { botId, ...(tab ? { tab } : {}) })) as
    | { tree?: string }
    | undefined;
  const tree = snapshot?.tree ?? "";
  const refOf = (label: RegExp) =>
    tree
      .split("\n")
      .find((line) => label.test(line))
      ?.match(/\be[1-9][0-9]*\b/)?.[0];
  const button = refOf(/button.*Go/i);
  const input = refOf(/textbox.*Name/i);
  const select = refOf(/combobox.*Choice|listbox.*Choice/i);
  record(
    "snapshot refs",
    !!(button && input && select),
    `button=${button} input=${input} select=${select}`,
  );
  if (button) await check("click", { botId, ref: button });
  if (input) await check("type", { botId, ref: input, text: "你好 Pi Bot" });
  if (select) await check("select", { botId, ref: select, value: "b" });
  await check("scroll", { botId, direction: "down", amount: 600 });
  await check("open", { botId, url: `${base}/two` });
  await check("back", { botId });
  await check("tabs", { botId });
  await check("screenshot", { botId });
  await check("wait", { botId, for: "text", value: "Page one", timeoutMs: 3000 });
  const focus = await evaluate(
    `chrome.windows.getLastFocused().then((w) => w.id === ${userWindow})`,
  );
  record("user window keeps focus", focus === true);
  const active = await evaluate(
    `chrome.tabs.query({ active: true, windowId: ${userWindow} }).then((t) => t[0]?.title)`,
  );
  record("user tab untouched", active === "user tab", String(active));
  const groups = await evaluate(
    "chrome.tabGroups.query({}).then((g) => g.map((x) => x.title + '|' + x.color + '|' + x.collapsed))",
  );
  record(
    "bot group",
    JSON.stringify(groups).includes("Pi Bot · 小媒|purple|false"),
    JSON.stringify(groups),
  );
  const listed = (await call("tabs", { botId })).result as { tabs?: { tab: string }[] } | undefined;
  const closing = listed?.tabs?.at(-1)?.tab;
  if (closing) await check("close", { botId, tab: closing });
  const stop = await call("stop", { botId });
  record("stop", !stop.error, JSON.stringify(stop.error ?? {}));
} catch (error) {
  record("probe", false, String(error));
} finally {
  chrome.kill();
  hostServer.close();
  http.close();
  await wait(1000);
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
