// The only way an external ACP agent process starts (hard rule 9). macOS / Linux run it inside
// the agent's outer sandbox; Windows has no command sandbox and runs it unisolated only after the
// user confirmed that agent — the brain passes `unisolated` only then.
import { isAbsolute, resolve } from "node:path";
import { startUnisolatedConnectorServer } from "../connectors/connector-unisolated.ts";
import { type ConnectorServerStream, openSandboxedStdio } from "../connectors/stdio-host.ts";
import { checkedRoot, within } from "../core/paths.ts";
import type { ExecRedactor } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import { childNodeRuntime } from "../runtime/child-node.ts";
import { recordAgentPlaceholders, removeAgentPlaceholders } from "./agent-placeholders.ts";
import {
  type ExternalAgentSandboxInput,
  externalAgentSandboxConfig,
} from "./external-agent-sandbox.ts";

export interface ExternalAgentLaunch {
  platform: NodeJS.Platform;
  isolation: "sandbox" | "unisolated";
  /**
   * `program`: the user's installed agent (absolute path). `node`: a pinned adapter script run by
   * Pi Bot's own runtime (Electron as Node), so the user needs no Node installation.
   */
  program:
    | { kind: "program"; path: string; args: readonly string[] }
    | { kind: "node"; script: string; args: readonly string[] };
  cwd: string;
  /** Explicit environment built by the caller; never Pi Bot's own keys. */
  env: NodeJS.ProcessEnv;
  sandbox: Omit<ExternalAgentSandboxInput, "signal" | "platform">;
  tempDir: string;
  signal: AbortSignal;
  redactor?: ExecRedactor;
  /** Dev-probe seam: run this host script instead of the built-in sandbox host. */
  hostScriptPath?: string;
  /** Linux: where absent placeholder names are recorded for cleanup after a crash. */
  placeholderLedger?: string;
}

export async function startExternalAgent(
  options: ExternalAgentLaunch,
): Promise<ConnectorServerStream> {
  options.signal.throwIfAborted();
  const { program } = options;
  const command = program.kind === "node" ? childNodeRuntime().executable : program.path;
  const args = program.kind === "node" ? [program.script, ...program.args] : [...program.args];
  if (!isAbsolute(command) || (program.kind === "node" && !isAbsolute(program.script)))
    throw new ExecError("invalid_input");
  const env: NodeJS.ProcessEnv = { ...options.env };
  const roots = options.sandbox.writeRoots;
  if (options.isolation === "unisolated") {
    if (options.platform !== "win32") throw new ExecError("isolation_unavailable");
    return startUnisolatedConnectorServer({
      platform: options.platform,
      command,
      args,
      cwd: options.cwd,
      env,
      readWriteRoots: roots,
      signal: options.signal,
    });
  }
  const cwd = await checkedRoot(resolve(options.cwd));
  const canonicalRoots = await Promise.all(roots.map((root) => checkedRoot(resolve(root))));
  if (!canonicalRoots.some((root) => within(root, cwd))) throw new ExecError("outside_workplace");
  // Linux leaves empty placeholders for denied names; note what is absent before the sandbox
  // (and Pi Bot's agent folders) exist, and remove what is still empty once the agent stops.
  const placeholders =
    options.platform === "linux"
      ? await recordAgentPlaceholders(canonicalRoots, options.placeholderLedger)
      : [];
  const config = await externalAgentSandboxConfig({
    ...options.sandbox,
    platform: options.platform,
    signal: options.signal,
  }).catch(async (error: unknown) => {
    await removeAgentPlaceholders(placeholders);
    throw error;
  });
  const stream = await openSandboxedStdio({
    platform: options.platform,
    config,
    allowAll: false,
    command,
    args,
    env,
    tempDir: options.tempDir,
    systemHome: options.sandbox.systemHome,
    home: { kind: "real", path: resolve(options.sandbox.systemHome), cwd },
    commandIdPrefix: "agent",
    kernelReports: true,
    // Every agent writes temp files somewhere; Claude Code ignores TMPDIR for its own folder.
    // npm (e.g. an agent's `npm exec typescript-language-server`) otherwise left
    // .cache/npm/_logs in the topic folder (Mac acceptance); its cache and logs stay private.
    agentTemp: {
      variables: ["CLAUDE_CODE_TMPDIR"],
      subfolders: { npm_config_cache: "npm-cache", npm_config_logs_dir: "npm-logs" },
    },
    signal: options.signal,
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.hostScriptPath ? { hostScriptPath: options.hostScriptPath } : {}),
  }).catch(async (error: unknown) => {
    await removeAgentPlaceholders(placeholders);
    throw error;
  });
  if (!placeholders.length) return stream;
  // The stream reports closed when its channel ends, which can be before bubblewrap and SRT have
  // finished: SRT removes its own placeholder files only on its way out, so a folder emptied by
  // that was still non-empty at the first pass (W/L retest: empty .claude/ .codex/ .cursor/ were
  // left for good). Passes run on close, after close() has waited for the whole group, and twice
  // more shortly after; each removes only what is still empty.
  let cleaned: Promise<void> | undefined;
  const cleanup = () => {
    cleaned ??= (async () => {
      for (const wait of [0, 1500, 5000]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
        await removeAgentPlaceholders(placeholders).catch(() => undefined);
      }
    })();
    return cleaned;
  };
  stream.onClose(() => {
    void cleanup();
  });
  return {
    ...stream,
    close: async () => {
      await stream.close();
      await removeAgentPlaceholders(placeholders).catch(() => undefined);
    },
  };
}
