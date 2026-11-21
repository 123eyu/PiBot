import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  ConnectorCallError,
  type ConnectorConnection,
  ConnectorNativeCallError,
  ConnectorNativeCallFailureSchema,
  ConnectorNativeError,
  ConnectorNativeFailureSchema,
  type ConnectorRemoteTool,
  connectorNativeDiagnostics,
} from "@pibot/protocol-base";
import { z } from "zod";

interface NativeConfig {
  scripts: Readonly<Partial<Record<"darwin" | "win32", string>>>;
  requestSchema: z.ZodType;
  accessPromptMs?: number;
}

export async function openNativeConnection(
  app: string,
  tools: readonly ConnectorRemoteTool[],
  driver: NativeConfig,
  signal: AbortSignal,
): Promise<ConnectorConnection> {
  const call = (
    request: { app: string; tool: string; args: Record<string, unknown> },
    callSignal: AbortSignal,
  ) =>
    runFixedServiceScript({
      request,
      requestSchema: driver.requestSchema,
      script: driver.scripts[process.platform as "darwin" | "win32"],
      accessPromptMs: driver.accessPromptMs,
      platform: process.platform,
      signal: callSignal,
    });
  let check: unknown;
  try {
    check = await call({ app, tool: "check", args: {} }, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DOMException) throw error;
    throw new ConnectorNativeError("native_app_failed");
  }
  if (!check || typeof check !== "object" || !("ok" in check) || check.ok !== true) {
    const code = check && typeof check === "object" && "code" in check ? check.code : undefined;
    const failure = ConnectorNativeFailureSchema.safeParse(code);
    throw new ConnectorNativeError(
      failure.success ? failure.data : "native_app_failed",
      connectorNativeDiagnostics({
        nativeDiagnostics:
          check && typeof check === "object" && "diagnostics" in check
            ? check.diagnostics
            : undefined,
      }),
    );
  }

  let closed = false;
  const abort = new AbortController();
  return {
    async listTools({ signal: listSignal }) {
      listSignal.throwIfAborted();
      if (closed) throw new Error("Connector closed");
      return { tools: [...tools] };
    },
    async callTool({ tool, args, signal: callSignal }) {
      if (closed || !tools.some((item) => item.name === tool))
        throw new Error("Connector tool unavailable");
      const boundedSignal = AbortSignal.any([
        callSignal,
        abort.signal,
        AbortSignal.timeout(30_000),
      ]);
      boundedSignal.throwIfAborted();
      const response = await call(
        {
          app,
          tool,
          args: args as Record<string, unknown>,
        },
        boundedSignal,
      );
      if (!response || typeof response !== "object" || !("ok" in response))
        throw new ConnectorCallError("unknown");
      if (response.ok !== true) {
        const failure = ConnectorNativeCallFailureSchema.safeParse(
          "code" in response ? response.code : undefined,
        );
        if (failure.success)
          throw new ConnectorNativeCallError(
            failure.data,
            connectorNativeDiagnostics({
              nativeDiagnostics: "diagnostics" in response ? response.diagnostics : undefined,
            }),
          );
        throw new ConnectorCallError("failed", "code" in response ? response.code : undefined);
      }
      return response;
    },
    onToolsChanged: () => () => undefined,
    async close() {
      closed = true;
      abort.abort();
    },
  };
}

/**
 * Executes only extension-compiled script text inside the already sandboxed MCP service process.
 * Neither imported manifests nor model arguments can select a command, script, or environment.
 */
async function runFixedServiceScript(input: {
  request: unknown;
  requestSchema: NativeConfig["requestSchema"];
  script: string | undefined;
  accessPromptMs?: number;
  platform: NodeJS.Platform;
  signal: AbortSignal;
}): Promise<unknown> {
  const request = input.requestSchema.parse(input.request);
  if (!input.script || (input.platform !== "darwin" && input.platform !== "win32"))
    return { ok: false, code: "unsupported_platform" };
  const check =
    !!request && typeof request === "object" && "tool" in request && request.tool === "check";
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(check ? (input.accessPromptMs ?? 30_000) + 10_000 : 30_000),
  ]);
  signal.throwIfAborted();
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const command =
    input.platform === "darwin"
      ? "/usr/bin/osascript"
      : join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args =
    input.platform === "darwin"
      ? ["-l", "JavaScript", "-e", input.script]
      : ["-NoProfile", "-NonInteractive", "-Command", input.script];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: input.platform === "darwin" ? { LANG: "en_US.UTF-8" } : { SystemRoot: windowsRoot },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill();
      force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
    };
    const abort = () => {
      failed = new DOMException(
        "Native app operation cancelled",
        signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError",
      );
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        failed = new Error("native_app_response_too_large");
        stop();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => {
      failed = new Error("native_app_dependency_missing");
    });
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (force) clearTimeout(force);
      if (failed) return reject(failed);
      if (code !== 0) return resolve({ ok: false, code: "dependency_missing" });
      try {
        resolve(z.json().parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch {
        reject(new Error("native_app_invalid_response"));
      }
    });
    if (signal.aborted) abort();
    child.stdin.end(JSON.stringify(request));
  });
}
