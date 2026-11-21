import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const calls = [];
const schema = {
  type: "object",
  properties: { target: { type: "string" }, content: { type: "string" } },
  required: ["target", "content"],
  additionalProperties: false,
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
// One serial protocol lane also serializes receipt writes; stdout is MCP frames only.
for await (const line of lines) {
  if (Buffer.byteLength(line) > 65536) {
    process.exitCode = 1;
    break;
  }
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
      serverInfo: { name: "e2e-echo", version: "1.0.0" },
    };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo_read",
          description: "Read synthetic fixture state",
          inputSchema: schema,
          annotations: { readOnlyHint: true },
        },
        {
          name: "echo_write",
          description: "Send synthetic text to a fixture recipient",
          inputSchema: schema,
          annotations: { readOnlyHint: false },
        },
      ],
    };
  else if (
    request.method === "tools/call" &&
    ["echo_read", "echo_write"].includes(request.params?.name)
  ) {
    const args = request.params.arguments;
    if (!args || typeof args.target !== "string" || typeof args.content !== "string")
      result = {
        isError: true,
        content: [{ type: "text", text: "invalid_fixture_arguments" }],
      };
    else {
      if (calls.length >= 64) throw new Error("fixture_receipt_limit");
      calls.push({
        name: request.params.name,
        arguments: args,
        at: Date.now(),
      });
      if (process.argv[2])
        await appendFile(
          process.argv[2],
          `${JSON.stringify({ name: request.params.name, arguments: args })}\n`,
          { mode: 0o600 },
        );
      result = {
        content: [{ type: "text", text: JSON.stringify({ fixtureReceipts: calls }) }],
      };
    }
  } else {
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "fixture_method_not_found" },
      }),
    );
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
