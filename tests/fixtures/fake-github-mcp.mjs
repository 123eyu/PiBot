// A stdio MCP server shaped like github/github-mcp-server's search tools, for the routine connection-upgrade probe.
// It answers search_issues / search_pull_requests from the JSON file named by argv[2], so the
// probe can make the result change or stay the same; `{"fail":true}` answers with an error.
// It writes nothing: a sandboxed connection may only read.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const searchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    sort: { type: "string", enum: ["comments", "created", "updated"] },
    order: { type: "string", enum: ["asc", "desc"] },
    perPage: { type: "number", minimum: 1, maximum: 100 },
    page: { type: "number", minimum: 1 },
  },
  required: ["query"],
  additionalProperties: false,
};
const tools = [
  { name: "search_issues", description: "Search issues", inputSchema: searchSchema },
  { name: "search_pull_requests", description: "Search pull requests", inputSchema: searchSchema },
  {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.exitCode = 1;
    break;
  }
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-github", version: "1.0.0" },
    };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") {
    const name = request.params?.name;
    const data = JSON.parse(await readFile(process.argv[2], "utf8"));
    const items = name === "search_pull_requests" ? data.pulls : data.issues;
    result = data.fail
      ? { isError: true, content: [{ type: "text", text: "rate limited" }] }
      : {
          content: [
            {
              type: "text",
              text: JSON.stringify({ total_count: items.length, incomplete_results: false, items }),
            },
          ],
        };
  }
  console.log(
    JSON.stringify(
      result === undefined
        ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }
        : { jsonrpc: "2.0", id: request.id, result },
    ),
  );
}
