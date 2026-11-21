import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "../context.mts";
import { until } from "../util.mts";

export async function run(c: Context) {
  let id = "";
  await c.step("import-mcp-and-classify", async () => {
    const manifest = {
      schemaVersion: 1,
      id: "e2e.echo",
      version: "1",
      name: { zh: "E2E echo", en: "E2E echo" },
      description: { zh: "本机合成夹具", en: "Local synthetic fixture" },
      servers: [
        {
          id: "echo",
          transport: "stdio",
          command: process.execPath,
          args: [join(c.root, "fixtures", "mcp-echo", "server.mjs")],
          auth: { kind: "none", secretNames: [] },
          networkDomains: [],
        },
      ],
    };
    await c.page.click("workspace.connectApps");
    await c.page.click("connections.add");
    await c.page.click("connections.add.plugin", { exact: false });
    await c.page.fill("connectors.json", JSON.stringify(manifest));
    await c.page.click("connectors.preview");
    await c.page.waitFor("connectors.importEnable");
    await c.page.click("connectors.importEnable");
    const connector = await until(
      "connector_ready",
      async () =>
        c.db.one(
          "SELECT c.id,c.catalog_version FROM connectors c JOIN plugin_installations p ON p.id=c.plugin_installation_id WHERE p.plugin_id='e2e.echo' AND c.removed_at IS NULL AND c.status='ready' ORDER BY c.created_at DESC LIMIT 1",
        ),
      Boolean,
      c.signal,
    );
    assert(connector);
    id = String(connector.id);
    // Connections opens on the Apps tab; an imported MCP server is listed under MCP.
    await c.page.click("connections.tab.mcp", { exact: false });
    await c.page.click("E2E echo", { exact: false });
    // The side panel summarises the connection; tool settings are behind 「更多设置」.
    const more = c.page.texts("connections.panel.more");
    assert(
      await c.page.eval<boolean>(
        `(() => { const b = [...document.querySelectorAll('button')].find(e => e.getClientRects().length && ${JSON.stringify(more)}.some(t => e.innerText.includes(t))); if (!b) return false; b.click(); return true; })()`,
      ),
      "connection_tools_link_missing",
    );
    await c.page.settle();
    // Per-tool settings sit in the collapsed 「高级」 section of the connector details.
    const advanced = c.page.texts("connectors.advanced");
    assert(
      await c.page.eval<boolean>(
        `(() => { const s = [...document.querySelectorAll('summary')].find(e => ${JSON.stringify(advanced)}.includes(e.innerText.trim())); if (!s) return false; if (!s.parentElement.open) s.click(); return true; })()`,
      ),
      "connector_advanced_missing",
    );
    await c.page.settle();
    await c.page.waitFor("connectors.tools");
    // Each tool has one permission select now (read-only / confirm writes / disabled), saved on
    // change; who may use the connection is the face row of the panel (this Bot already ticked).
    const setMode = async (name: string, mode: "read_only" | "confirm_write") => {
      const labels = c.page.texts("connectors.toolModeFor", { name });
      await until(
        `tool_mode:${name}`,
        () =>
          c.page.eval<boolean>(`(() => {
            const el = [...document.querySelectorAll('select')].find(e => ${JSON.stringify(labels)}.includes(e.getAttribute('aria-label')));
            if (!el || el.disabled) return false;
            if (el.value === ${JSON.stringify(mode)}) return true;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(mode)});
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return false;
          })()`),
        Boolean,
        c.signal,
      );
    };
    await setMode("Echo read", "read_only");
    await setMode("Echo write", "confirm_write");
    await until(
      "connector_classification",
      async () =>
        // Saving tool settings publishes a new catalog version; read the connector's current one.
        c.db.one(
          "SELECT t.read_only FROM connector_tools t JOIN connectors c ON c.id=t.connector_id AND c.catalog_version=t.catalog_version WHERE t.connector_id=? AND t.tool_name='echo_read' LIMIT 1",
          id,
        )?.read_only === 1,
      Boolean,
      c.signal,
    );
    const catalog = {
      items: c.db.rows(
        "SELECT t.tool_name AS tool,t.catalog_version AS catalogVersion FROM connector_tools t JOIN connectors c ON c.id=t.connector_id AND c.catalog_version=t.catalog_version WHERE t.connector_id=? LIMIT 50",
        id,
      ),
    };
    assert.equal(catalog.items.length, 2, "fixture_tool_count");
    for (const reply of c.scenario.replies)
      for (const call of reply.toolCalls ?? []) {
        if (call.name === "connector_discover") call.arguments.connectorId = id;
        if (call.name === "connector_call") {
          const tool = catalog.items.find((tool) => tool.tool === call.arguments.tool);
          assert(tool, "fixture_tool_missing");
          call.arguments.connectorId = id;
          call.arguments.catalogVersion = tool.catalogVersion;
        }
      }
    await c.page.key("Escape");
    await c.chat();
  });
  await c.step("readonly-call-without-card", async () => {
    const receipt = await c.receipt("Read synthetic connector state.");
    await c.done(receipt);
    const audit = c.db.rows(
      "SELECT kind FROM audit_log WHERE bot_id=? AND run_id=? ORDER BY at DESC LIMIT 200",
      c.bot.id,
      receipt.runId,
    );
    assert(!audit.some((row) => row.kind === "approval.requested"), "readonly_prompted");
    assert(
      c.mcpCalls.some((call) => call.name === "echo_read"),
      "readonly_not_called",
    );
  });
  await c.step("write-draft-before-dispatch", async () => {
    const receipt = await c.receipt("Send the synthetic connector message.");
    const draft = await until(
      "send_draft",
      async () =>
        c.db.one(
          "SELECT approval_id FROM send_drafts WHERE connector_id=? AND status='pending' LIMIT 1",
          id,
        ),
      Boolean,
      c.signal,
    );
    assert(draft);
    assert(!c.mcpCalls.some((call) => call.name === "echo_write"), "write_before_confirmation");
    await c.page.waitFor("draft.view");
    await c.page.click("draft.view");
    await c.page.waitFor("E2E recipient");
    await c.page.shot("connector-send-draft");
    const confirmedAt = Date.now();
    await c.page.click("draft.send");
    await until(
      "draft_sent",
      async () =>
        c.db.one(
          "SELECT status FROM send_drafts WHERE approval_id=? LIMIT 1",
          String(draft.approval_id),
        )?.status === "sent",
      Boolean,
      c.signal,
    );
    await c.done(receipt);
    await c.send("Read the synthetic receipt ledger after the confirmed send.");
    const writes = c.mcpCalls.filter((row) => row.name === "echo_write");
    assert.equal(writes.length, 1, "write_receipt_count");
    assert(writes[0] && writes[0].at >= confirmedAt, "write_before_confirmation");
    assert.deepEqual(writes[0].arguments, {
      target: "E2E recipient",
      content: "E2E payload",
    });
  });
}
