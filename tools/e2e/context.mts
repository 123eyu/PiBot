import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { Cdp } from "../dev/cdp/cdp.ts";
import { Page } from "../dev/cdp/page.ts";
import type { Scenario } from "../fake-llm/scenario.ts";
import { Data } from "./data.mts";
import { initialize } from "./initialize.mts";
import { Ui } from "./ui.mts";
import { until } from "./util.mts";

export interface StepResult {
  flow: string;
  step: string;
  ok: boolean;
  screenshot?: string;
  reason?: string;
  temporaryDirectory?: string;
  logs?: string[];
}
export class Context {
  readonly db: Data;
  readonly ui: Ui;
  readonly secrets: [string] = [`E2E-password-${randomUUID()}`];
  readonly connections: Cdp[] = [];
  bot!: { id: string; name: string };
  conversationId?: string;
  modelRequests = 0;
  /** Recent model request bodies (bounded), for flows that read tool results or scan for leaks. */
  readonly requestTexts: string[] = [];
  /** Called with each model request before the fake model picks its reply (same run steps). */
  onRequest?: (text: string) => void;
  readonly name: string;
  readonly page: Page;
  readonly scenario: Scenario;
  readonly root: string;
  readonly data: string;
  readonly out: string;
  readonly ownerPort: number;
  readonly signal: AbortSignal;
  readonly report: (result: StepResult) => Promise<void>;
  constructor(
    name: string,
    page: Page,
    scenario: Scenario,
    root: string,
    data: string,
    out: string,
    ownerPort: number,
    signal: AbortSignal,
    report: (result: StepResult) => Promise<void>,
  ) {
    this.name = name;
    this.page = page;
    this.scenario = scenario;
    this.root = root;
    this.data = data;
    this.out = out;
    this.ownerPort = ownerPort;
    this.signal = signal;
    this.report = report;
    this.db = new Data(data);
    this.ui = new Ui(page, signal);
  }
  async step(name: string, action: () => Promise<unknown>) {
    try {
      this.signal.throwIfAborted();
      await action();
      const screenshot = await this.page.shot(name);
      await this.report({ flow: this.name, step: name, ok: true, screenshot });
    } catch (error) {
      const screenshot = await this.page.shot(`${name}-failed`).catch(() => undefined);
      const raw = error instanceof Error ? error.message : "e2e_unknown_failure";
      const reason = this.secrets
        .reduce((s, secret) => s.replaceAll(secret, "[redacted]"), raw)
        .slice(0, 500);
      await this.report({
        flow: this.name,
        step: name,
        ok: false,
        screenshot,
        reason,
      });
      throw new Error(`e2e_step_failed:${name}`);
    }
  }
  async initialize(url: string) {
    return initialize(this, url);
  }
  async settings(section?: string) {
    await this.page.click("appMenu.title");
    await this.page.click("settings.title");
    if (section) await this.page.click(section);
  }
  async chat() {
    await this.page.click("workspace.inboxShort", { exact: false });
    await this.page.click(this.bot.name, { exact: false });
  }
  async receipt(text: string) {
    const before = this.db.rows(
      "SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.bot_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT 200",
      this.bot.id,
    );
    const known = new Set(before.map((row) => row.id));
    await this.ui.chatText(text);
    await this.page.click("chat.send");
    const message = await until(
      "assistant_created",
      async () =>
        this.db
          .rows(
            "SELECT m.id,m.run_id,m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.bot_id=? AND m.role='assistant' ORDER BY m.created_at DESC,m.id DESC LIMIT 100",
            this.bot.id,
          )
          .find((row) => !known.has(row.id)),
      Boolean,
      this.signal,
    );
    assert(message);
    this.conversationId = String(message.conversation_id);
    return { assistantMessageId: String(message.id), runId: String(message.run_id) };
  }
  async done(receipt: { assistantMessageId: string }) {
    const message = await until(
      "assistant_terminal",
      async () =>
        this.db.one(
          "SELECT status,content FROM messages WHERE id=? LIMIT 1",
          receipt.assistantMessageId,
        ),
      (row) => !!row && row.status !== "streaming",
      this.signal,
      90000,
    );
    assert.equal(message?.status, "done", "e2e_run_not_done");
    return message;
  }
  async send(text: string) {
    return this.done(await this.receipt(text));
  }
  async approval(decision: "allow" | "deny") {
    const card = await until(
      "approval",
      async () =>
        this.db.one(
          "SELECT id FROM approvals WHERE bot_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
          this.bot.id,
        ),
      Boolean,
      this.signal,
    );
    assert(card);
    await this.page.waitFor("approval.allowOnce");
    await this.page.shot(`approval-${decision}-pending`);
    await this.page.click(decision === "allow" ? "approval.allowOnce" : "approval.deny");
    return card;
  }
  async fixture(kind: "login" | "teach" | "secret", port: number, token: string) {
    // Bot-owned home is explicitly readable under the real temporary-directory boundary.
    const fixtures = join(this.data, "bots", this.bot.id, "home", "e2e-fixtures");
    await cp(join(this.root, "fixtures"), fixtures, { recursive: true });
    const script = join(fixtures, `${kind}-site`, "server.mjs");
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    // These are fixed fixture paths and synthetic values, never a user-provided shell fragment.
    const command = `${quote(process.execPath)} ${quote(script)} ${port} ${quote(token)}`;
    for (const reply of this.scenario.replies)
      for (const call of reply.toolCalls ?? [])
        if (call.name === "browser_open") call.arguments.url = `http://127.0.0.1:${port}/`;
    this.scenario.replies.splice(
      this.modelRequests,
      0,
      {
        toolCalls: [{ name: "run_command", arguments: { command, background: true } }],
      },
      { text: "E2E fixture ready" },
    );
    const receipt = await this.receipt("Start the approved synthetic local fixture server.");
    await this.approval("allow");
    await this.done(receipt);
    const url = `http://127.0.0.1:${port}`;
    await until(
      "fixture_ready",
      async () =>
        fetch(`${url}/__receipt`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        })
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      this.signal,
    );
    // HTTP readiness and the Bot-owned command are observed without writing product state.
    await until(
      "owned_background_command",
      async () =>
        this.db.one(
          "SELECT id FROM background_commands WHERE bot_id=? AND status='running' LIMIT 1",
          this.bot.id,
        ),
      Boolean,
      this.signal,
    );
    // A listener shows either as a plain port or as the "open in the Bot browser" action.
    const labels = [
      ...this.page.texts("background.port", { port }),
      ...this.page.texts("background.openPort", { port }),
    ];
    await until(
      "owned_listener_ui",
      () =>
        this.page.eval<boolean>(
          `${JSON.stringify(labels)}.some(text=>document.body.innerText.includes(text))`,
        ),
      Boolean,
      this.signal,
    );
    return url;
  }
  async browser(url: string) {
    const cdp = await Cdp.target(this.ownerPort, (target) => target.startsWith(url));
    this.connections.push(cdp);
    const page = new Page(cdp, this.out);
    await page.start({ waitForApp: false });
    return { cdp, page };
  }
  readonly mcpCalls: {
    name: string;
    arguments: { target: string; content: string };
    at: number;
  }[] = [];
  observeFixture(value: unknown, depth = 0): void {
    if (depth > 12) return;
    if (typeof value === "string") {
      try {
        this.observeFixture(JSON.parse(value), depth + 1);
      } catch {
        /* Ordinary tool text is not JSON. */
      }
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (Array.isArray(object.fixtureReceipts)) {
        const calls = object.fixtureReceipts as typeof this.mcpCalls;
        if (
          calls.length <= 64 &&
          calls.every(
            (call) =>
              ["echo_read", "echo_write"].includes(call.name) &&
              Number.isSafeInteger(call.at) &&
              typeof call.arguments?.target === "string" &&
              typeof call.arguments?.content === "string",
          )
        ) {
          this.mcpCalls.splice(0, this.mcpCalls.length, ...calls);
        }
      }
      for (const child of Object.values(object)) this.observeFixture(child, depth + 1);
    }
  }
}
