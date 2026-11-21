import assert from "node:assert/strict";
import { createRequire } from "node:module";

const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti");
const loader = createJiti(import.meta.url, { fsCache: false });

const { mapConnectorCapabilities } = (await loader.import(
  "../../../packages/plugins/src/brain/capability-mappings/index.ts",
)) as { mapConnectorCapabilities(input: unknown): unknown };
const { PluginRegistry } = (await loader.import(
  "../../../packages/plugins/src/brain/apps/registry.ts",
)) as { PluginRegistry: new (apps: readonly unknown[]) => unknown };
const { connectorToolIndex } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/connector-index.ts",
)) as { connectorToolIndex(...args: unknown[]): { text: string } | undefined };
const { policyRequest } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/tools.ts",
)) as { policyRequest(...args: unknown[]): { category: string; url?: string } };
const { website } = (await loader.import("../../../packages/policy/src/targets/web.ts")) as {
  website(url: string): { denied: boolean };
};
const { connectorCapabilityDefinition, prepareCapabilityConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/capability-adapter.ts",
)) as {
  connectorCapabilityDefinition(
    ...args: unknown[]
  ): { name: string; description: string; parameters: unknown; executionMode?: string } | undefined;
  prepareCapabilityConnector(...args: unknown[]): { input: { args: Record<string, unknown> } };
};
const { executeCapabilityConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/capability-execute.ts",
)) as { executeCapabilityConnector(...args: unknown[]): Promise<{ text: string }> };
const { pibotCapabilitiesExtension } = (await loader.import(
  "../../../packages/agent/src/extensions/pibot-capabilities.ts",
)) as {
  pibotCapabilitiesExtension(
    ...args: unknown[]
  ): (pi: { registerTool(tool: unknown): void }) => void;
};
const { ConnectorToolError, executeConnector, prepareConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/connector-tools.ts",
)) as {
  ConnectorToolError: new (code: string) => Error & { code: string };
  executeConnector(...args: unknown[]): Promise<{ text: string }>;
  prepareConnector(...args: unknown[]): unknown;
};

interface ProbeTool {
  tool: string;
  description: string;
  schema: Record<string, unknown>;
  suggestedReadOnly: boolean;
  capabilityId?: string;
  capabilityTool?: string;
  capabilityReadOnly?: boolean;
  connectorId: string;
  catalogVersion: number;
  enabled: boolean;
  readOnly: boolean;
}

const connectorId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const botId = "33333333-3333-4333-8333-333333333333";
const connector = {
  id: connectorId,
  pluginInstallationId: pluginId,
  serverId: "echo",
  revision: 1,
  catalogVersion: 1,
  kind: "mcp_stdio",
  identity: "user",
  confirmationMode: "read_write",
  name: "E2E echo filesystem fingerprint",
  enabled: true,
  status: "ready",
  statusDetailCode: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
};
const plugin = {
  id: pluginId,
  pluginId: "e2e.echo",
  version: "1",
  digest: "a".repeat(64),
  revision: 1,
  sourceKind: "json",
  status: "installed",
  enabled: true,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
};
const discovered = [
  "read_text_file",
  "list_directory",
  "search_files",
  "write_file",
  "edit_file",
  "echo_unmapped",
].map((tool) => ({
  tool,
  description: `Synthetic ${tool}`,
  schema: { type: "object", properties: {}, additionalProperties: false },
  suggestedReadOnly: tool !== "write_file" && tool !== "edit_file",
}));
const tools = (
  mapConnectorCapabilities({
    registry: new PluginRegistry([]),
    connector,
    plugin,
    tools: discovered,
  }) as Array<Omit<ProbeTool, "connectorId" | "catalogVersion" | "enabled" | "readOnly">>
).map(
  (tool): ProbeTool => ({
    ...tool,
    connectorId,
    catalogVersion: 1,
    enabled: true,
    readOnly: tool.suggestedReadOnly,
  }),
);

const context = {
  botId,
  runId: "44444444-4444-4444-8444-444444444444",
  messageId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
  language: "zh",
};
const redactor = { redact: (value: string) => value };
const access = { mode: "all", bots: [] };
let selected = new Map([
  ["files.read", "builtin"],
  ["files.write", "builtin"],
]);

const port = {
  get: () => connector,
  access: () => access,
  tool: (_id: string, _version: number, toolName: string) =>
    tools.find((tool) => tool.tool === toolName),
  plugin: () => plugin,
  allowAllFromApproval: () => connector,
  appName: () => undefined,
  getConnector: () => ({ connector, access }),
  discoverToolsForBot: (_botId: string, input: { cursor?: string }) => ({
    items: tools,
    nextCursor: input.cursor ? null : null,
  }),
  capabilitySuggestions: () =>
    [...new Set(tools.flatMap((tool) => (tool.capabilityId ? [tool.capabilityId] : [])))].sort(),
  capabilityTools: (_botId: string, _connectorId: string, capabilityId: string) =>
    tools.filter((tool) => tool.capabilityId === capabilityId),
  resolveTool: (_botId: string, input: { tool: string }) => {
    const tool = tools.find((candidate) => candidate.tool === input.tool);
    assert(tool);
    return {
      pluginRevision: 1,
      pluginDigest: plugin.digest,
      connector,
      access,
      tool,
      argsDigest: "digest",
    };
  },
  dispatchCapability: () => Promise.resolve({}),
};
const local = {
  connectors: port,
  capabilities: { resolve: () => selected },
  execution: { mode: () => "normal" },
  drafts: { assertReplay: () => undefined },
  deps: { redactor },
};

const readTool = tools.find((tool) => tool.tool === "read_text_file");
const unmappedTool = tools.find((tool) => tool.tool === "echo_unmapped");
assert.equal(readTool?.capabilityId, "files.read");
assert.equal(readTool?.capabilityTool, "read_file");
assert.equal(unmappedTool?.capabilityId, undefined);
assert.deepEqual(port.capabilitySuggestions(), ["files.read", "files.write"]);

const offered = [{ name: "connector_discover" }];
const defaultIndex = connectorToolIndex(local, context, offered);
assert(defaultIndex?.text.includes("echo_unmapped"), "unmapped tool must remain in the index");
assert(!defaultIndex?.text.includes("read_text_file"), "builtin-owned read tool leaked into index");

const discoverResult = await executeConnector(
  { local, context, assertDispatch: () => undefined },
  {},
  { tool: "connector_discover", args: { limit: 20 } },
  context.signal,
);
const defaultDiscover = JSON.parse(discoverResult.text) as { items: ProbeTool[] };
assert.deepEqual(
  defaultDiscover.items.map((tool) => tool.tool),
  ["echo_unmapped"],
);

assert.throws(
  () =>
    prepareConnector(local, context, {
      tool: "connector_call",
      args: {
        connectorId,
        catalogVersion: 1,
        tool: "read_text_file",
        args: {},
      },
    }),
  (error: unknown) =>
    error instanceof ConnectorToolError && error.code === "capability_served_elsewhere",
);

selected = new Map([
  ["files.read", `connector:${connectorId}`],
  ["files.write", "builtin"],
]);
(context as typeof context & { capabilities: typeof selected }).capabilities = selected;
const selectedIndex = connectorToolIndex(local, context, offered);
assert(
  !selectedIndex?.text.includes("read_text_file"),
  "adapted raw connector tool leaked into index",
);
assert(
  !selectedIndex?.text.includes("write_file"),
  "unselected write capability leaked into index",
);
assert.throws(
  () =>
    prepareConnector(local, context, {
      tool: "connector_call",
      args: {
        connectorId,
        catalogVersion: 1,
        tool: "read_text_file",
        args: {},
      },
    }),
  (error: unknown) =>
    error instanceof ConnectorToolError && error.code === "capability_served_elsewhere",
);

const builtinReadFile = {
  name: "read_file",
  description: "Stable read description",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  executionMode: "parallel",
};
const adaptedReadFile = connectorCapabilityDefinition(
  local,
  context,
  builtinReadFile,
  "files.read",
);
assert(adaptedReadFile);
assert.equal(adaptedReadFile.name, builtinReadFile.name);
assert.equal(adaptedReadFile.description, builtinReadFile.description);
assert.deepEqual(adaptedReadFile.parameters, builtinReadFile.parameters);
assert.equal(adaptedReadFile.executionMode, builtinReadFile.executionMode);
let registered: Record<string, unknown> | undefined;
pibotCapabilitiesExtension(
  { capabilityDefinitions: [adaptedReadFile] },
  new Map(),
)({ registerTool: (tool) => (registered = tool as Record<string, unknown>) });
assert.equal(registered?.name, "read_file");
assert.equal(registered?.description, builtinReadFile.description);
assert.deepEqual(registered?.parameters, builtinReadFile.parameters);
assert.equal(registered?.executionMode, "sequential");

const canonicalRead = prepareCapabilityConnector(
  local,
  context,
  { tool: "read_file", args: { path: "../../outside" } },
  { capabilityId: "files.read", connectorId, tool: readTool },
  { decision: "allow", path: { path: "/workspace/allowed.txt" } },
);
assert.equal(canonicalRead.input.args.path, "/workspace/allowed.txt");
assert.throws(
  () =>
    prepareCapabilityConnector(
      local,
      context,
      { tool: "read_file", args: { path: "../../outside" } },
      { capabilityId: "files.read", connectorId, tool: readTool },
      { decision: "deny", reason: "outside_workplace" },
    ),
  (error: unknown) =>
    error instanceof ConnectorToolError && error.code === "connector_context_denied",
);

const fetchTool = {
  ...readTool,
  tool: "fetch",
  capabilityId: "web.fetch",
  capabilityTool: "web_fetch",
  capabilityReadOnly: true,
};
const privateRequest = policyRequest({
  tool: "web_fetch",
  args: { url: "http://127.0.0.1/private" },
});
assert.equal(privateRequest.category, "web");
assert(privateRequest.url && website(privateRequest.url).denied, "private URL was not denied");
let dispatches = 0;
const webPrepared = {
  call: {
    id: "66666666-6666-4666-8666-666666666666",
    tool: "web_fetch",
    input: { url: "http://127.0.0.1/private", question: "Needle?" },
  },
  result: { decision: "allow", url: "http://127.0.0.1/private" },
  capabilityConnector: {
    capabilityId: "web.fetch",
    input: {
      connectorId,
      catalogVersion: 1,
      tool: "fetch",
      args: { url: "http://127.0.0.1/private" },
    },
  },
  connector: {
    pluginRevision: 1,
    pluginDigest: plugin.digest,
    connector,
    access,
    tool: fetchTool,
    argsDigest: "digest",
  },
};
const audit: unknown[] = [];
const webLocal = {
  ...local,
  connectors: {
    ...port,
    dispatchCapability: async (...args: unknown[]) => {
      dispatches++;
      (args.at(-1) as () => void)();
      return { content: [{ type: "text", text: "Needle ".repeat(700) }] };
    },
  },
  approvals: { audit: { append: (row: unknown) => audit.push(row) } },
  budgets: { observer: () => undefined },
  deps: {
    redactor,
    logger: { info: () => undefined, warn: () => undefined },
    extractPage: async () => ({
      text: "EXTRACTED NEEDLE",
      readChars: 4900,
      model: { provider: "fake", id: "fake" },
    }),
  },
};
const deniedRun = {
  local: webLocal,
  context: { ...context, capabilities: new Map([["web.fetch", `connector:${connectorId}`]]) },
  allowPage: async () => false,
  assertDispatch: () => undefined,
  extractPage: webLocal.deps.extractPage,
  redact: (text: string) => redactor.redact(text),
  log: () => undefined,
  mapPageError: () => "internal",
  auditInput: (fields: unknown, input: unknown) => audit.push({ fields, input }),
};
// A private target is refused before anything else, exactly as Pi Bot's own fetcher would.
await assert.rejects(
  executeCapabilityConnector(
    deniedRun,
    webPrepared,
    { tool: "web_fetch", args: webPrepared.call.input },
    context.signal,
  ),
  (error: unknown) =>
    (error as { code?: string; reason?: string }).code === "web_blocked" &&
    (error as { reason?: string }).reason === "private_address",
);
// A public target the user did not allow is refused by the page approval.
const publicPrepared = {
  ...webPrepared,
  result: { decision: "allow", url: "https://example.com/page" },
  call: { ...webPrepared.call, input: { url: "https://example.com/page", question: "Needle?" } },
};
await assert.rejects(
  executeCapabilityConnector(
    deniedRun,
    publicPrepared,
    { tool: "web_fetch", args: publicPrepared.call.input },
    context.signal,
  ),
  (error: unknown) =>
    error instanceof ConnectorToolError && error.code === "connector_context_denied",
);
assert.equal(dispatches, 0, "private/denied page reached MCP dispatch");
const extracted = await executeCapabilityConnector(
  { ...deniedRun, allowPage: async () => true },
  { ...webPrepared, result: { decision: "allow", url: "https://example.com/page" } },
  {
    tool: "web_fetch",
    args: { url: "https://example.com/page", question: "Needle?" },
  },
  context.signal,
);
assert(
  extracted.text.includes("EXTRACTED NEEDLE"),
  "connector web result skipped extraction",
);
assert.equal(dispatches, 1);
assert(audit.length >= 3, "connector and web audits were not recorded");

console.log(
  JSON.stringify({
    probe: "MCP stable capability adapter",
    status: "passed",
    suggestions: port.capabilitySuggestions(),
  }),
);
