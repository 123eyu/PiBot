// Default-selection regression probe (Claude review 2026-10-24): with no user choice, what
// worked before the tool plane must keep working — the native calendar / contacts connections (GitHub /
// Notion / Figma stopped being built in) (ordinary connections, native first; maintainers 2026-10-24) stay
// visible — while a user-added filesystem-type MCP yields to the built-in file tools. No network,
// no real data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti");
const loader = createJiti(import.meta.url, { fsCache: false });

const { applyMigrations } = (await loader.import(
  "../../../packages/storage/src/database/database.ts",
)) as { applyMigrations(db: DatabaseSync, dir: string): void };
const { StoredCapabilityResolver } = (await loader.import(
  "../../../packages/brain/src/core/stored-capability-resolver.ts",
)) as {
  StoredCapabilityResolver: new (deps: unknown) => { resolve(scope: unknown): Map<string, string> };
};
const { defaultCapabilityResolver } = (await loader.import(
  "../../../packages/brain/src/core/capability-resolver.ts",
)) as { defaultCapabilityResolver(): unknown };
const { filterConnectorCapabilities } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/capability-filter.ts",
)) as { filterConnectorCapabilities(...args: unknown[]): Array<{ tool: string }> };

const ids = {
  bot: "33333333-3333-4333-8333-333333333333",
  contacts: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  calendar: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  filesystem: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const connectors: Record<string, Record<string, unknown>> = {
  [ids.contacts]: {
    id: ids.contacts,
    kind: "builtin",
    appId: "contacts",
    enabled: true,
    status: "ready",
  },
  [ids.calendar]: {
    id: ids.calendar,
    kind: "builtin",
    appId: "calendar",
    enabled: true,
    status: "ready",
  },
  [ids.filesystem]: { id: ids.filesystem, kind: "mcp_stdio", enabled: true, status: "ready" },
};
const tool = (connectorId: string, name: string, capabilityId: string) => ({
  connectorId,
  tool: name,
  capabilityId,
  catalogVersion: 1,
  enabled: true,
  readOnly: true,
});
const tools = [
  tool(ids.contacts, "search_contacts", "contacts"),
  tool(ids.calendar, "list_events", "calendar"),
  tool(ids.filesystem, "read_text_file", "files.read"),
];
const port = {
  get: (id: string) => connectors[id],
  access: () => ({ mode: "all", bots: [] }),
  discoverToolsForBot: () => ({ items: tools, nextCursor: null }),
  capabilityConnectors: (capabilityId: string) =>
    tools.filter((t) => t.capabilityId === capabilityId).map((t) => t.connectorId),
};
const levels = new Proxy({}, { get: () => "ask" });
const permissions = {
  effective: () => ({ levels }),
  effectiveGroup: () => ({ levels }),
  repo: { get: () => ({ levels }) },
};

const db = new DatabaseSync(":memory:");
applyMigrations(
  db,
  fileURLToPath(new URL("../../../packages/storage/migrations", import.meta.url)),
);
const resolver = new StoredCapabilityResolver({
  db,
  defaults: defaultCapabilityResolver(),
  permissions,
  connectors: () => port,
});
const selections = resolver.resolve({ botId: ids.bot });

assert.equal(
  selections.get("contacts"),
  `connector:${ids.contacts}`,
  "contacts defaults to the Local contacts connection",
);
assert.equal(
  selections.get("calendar"),
  `connector:${ids.calendar}`,
  "calendar defaults to the Local calendar connection",
);
assert.equal(selections.get("files.read"), "builtin", "file reads default to built-in");

// The global view (no Bot) shows the same default, and offers the connection as a choice.
const global = (
  resolver as unknown as {
    list(p: unknown): {
      items: Array<{ id: string; impl: string; available: Array<{ impl: string }> }>;
    };
  }
).list({}).items;
const globalContacts = global.find((item) => item.id === "contacts");
assert.equal(
  globalContacts?.impl,
  `connector:${ids.contacts}`,
  "global view shows the contacts default",
);
assert(
  global
    .find((item) => item.id === "web.fetch")
    ?.available.every((o) => !o.impl.startsWith("connector:")),
  "no fetch-type connection, no connection option",
);
assert(
  global
    .find((item) => item.id === "files.read")
    ?.available.some((o) => o.impl === `connector:${ids.filesystem}`),
  "a filesystem-type MCP can be chosen for file reads",
);
assert.equal(
  global.find((item) => item.id === "calendar")?.impl,
  `connector:${ids.calendar}`,
  "the global view shows the Local calendar connection",
);

const visible = filterConnectorCapabilities(
  { connectors: port, capabilities: resolver },
  { botId: ids.bot, capabilities: selections },
  tools,
  selections,
).map((item) => item.tool);
assert.deepEqual(visible.sort(), ["list_events", "search_contacts"]);

db.close();
console.log(
  JSON.stringify({
    probe: "default selection keeps earlier connections",
    status: "passed",
    visible,
  }),
);
