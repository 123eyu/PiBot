#!/usr/bin/env node
// Acceptance-only sandbox-host double. It launches the trusted synthetic MCP command outside SRT;
// production never receives this path, and imported manifests cannot select a host implementation.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).once("line", (line) => {
  const payload = JSON.parse(line);
  const child = spawn("/bin/bash", ["-lc", payload.command], {
    cwd: payload.cwd,
    env: payload.env,
    stdio: [4, 5, "inherit"],
  });
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
  process.stdin.once("end", () => child.kill("SIGTERM"));
  writeSync(3, "ready\n");
});
