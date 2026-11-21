import { join } from "node:path";
import type { BrainRedactor } from "@pibot/brain/kit";
import {
  type AgentBridgeEndpoint,
  type ConnectorServerStream,
  startExternalAgent,
} from "@pibot/execution";
import {
  agentAllowances,
  type CustomAgent,
  type ExternalAgentId,
} from "@pibot/external-agents-contract";

type NetworkProxy = { url: string };

/** What the capability needs from the brain host to start an agent process. */
/** Linux: placeholder names agent sandboxes may have left; cleaned at the next start. */
export const agentPlaceholderLedger = (dataDir: string) =>
  join(dataDir, "agent-placeholders.jsonl");

export interface LaunchDeps {
  dataDir: string;
  platform: "darwin" | "linux" | "win32";
  /** The brain's own, already reduced environment; only allowlisted names are copied. */
  env: Readonly<NodeJS.ProcessEnv>;
  userHome: string;
  tempDir: string;
  /** Packaged resources (ripgrep, seccomp helper); absent when running from the workspace. */
  resourcesDir?: string;
  proxy?: () => NetworkProxy | undefined;
  redactor: BrainRedactor;
  /** Pi Bot's MCP bridge endpoint, once listening; the sandbox lets the agent reach it. */
  bridge?: () => AgentBridgeEndpoint | undefined;
}

/**
 * Names an agent needs to find itself and its login, and nothing that carries a credential: Pi
 * Bot never hands its own API keys to an agent.
 */
const POSIX_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TERM"];
const WINDOWS_ENV = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
];

export function agentEnvironment(
  deps: LaunchDeps,
  extra: Record<string, string> = {},
  agentId?: ExternalAgentId,
) {
  const names = deps.platform === "win32" ? WINDOWS_ENV : POSIX_ENV;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(deps.env))
    if (value !== undefined && names.some((name) => name.toUpperCase() === key.toUpperCase()))
      env[key] = value;
  if (deps.platform === "win32") env.USERPROFILE ??= deps.userHome;
  return {
    ...env,
    ...extra,
    // OpenCode 1.19.5 defaults to allowing edits without an ACP permission request. Its
    // process-local override keeps those actions on Pi Bot's existing policy/approval path
    // without changing the person's config or permissions for reads, networking or MCP.
    ...(agentId === "opencode"
      ? { OPENCODE_PERMISSION: JSON.stringify({ edit: "ask", bash: "ask" }) }
      : {}),
  };
}

export interface LaunchInput {
  agent: { id: ExternalAgentId; custom: CustomAgent | null };
  /** `program`: the user's installed agent; `adapter`: a pinned script run by Pi Bot's Node. */
  target:
    | { kind: "program"; path: string; args: readonly string[] }
    | {
        kind: "adapter";
        entry: string;
        folder: string;
        /** Further read-only folders in Pi Bot's data the adapter needs (Codex's launcher). */
        readRoots?: readonly string[];
      };
  cwd: string;
  writeRoots: readonly string[];
  /** The agent Bot: its own default folder in Pi Bot's data may be a write root. */
  botId?: string;
  /** A group plan step: the group's default folder in Pi Bot's data may be a write root. */
  groupId?: string;
  isolation: "sandbox" | "unisolated";
  /** Detection runs `--version` with no network at all. */
  offline?: boolean;
  env?: Record<string, string>;
  signal: AbortSignal;
}

export function launchAgent(deps: LaunchDeps, input: LaunchInput): Promise<ConnectorServerStream> {
  const allowances = agentAllowances(input.agent, deps.platform);
  // Detection (offline) never talks to Pi Bot; Windows has no sandbox to open it in.
  const bridge = input.offline ? undefined : deps.bridge?.();
  return startExternalAgent({
    platform: deps.platform,
    isolation: input.isolation,
    program:
      input.target.kind === "adapter"
        ? { kind: "node", script: input.target.entry, args: [] }
        : { kind: "program", path: input.target.path, args: input.target.args },
    cwd: input.cwd,
    env: agentEnvironment(deps, input.env, input.agent.id),
    sandbox: {
      systemHome: deps.userHome,
      env: deps.env,
      dataDir: deps.dataDir,
      writeRoots: input.writeRoots,
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      readRoots:
        input.target.kind === "adapter"
          ? [input.target.folder, ...(input.target.readRoots ?? [])]
          : [],
      allowances: input.offline ? { ...allowances, network: [] } : allowances,
      ...(deps.proxy?.() ? { parentProxy: deps.proxy()?.url } : {}),
      tempDir: deps.tempDir,
      ...(deps.resourcesDir ? { resourcesDir: deps.resourcesDir } : {}),
      ...(bridge && input.isolation === "sandbox" ? { bridge } : {}),
    },
    tempDir: deps.tempDir,
    placeholderLedger: agentPlaceholderLedger(deps.dataDir),
    signal: input.signal,
    redactor: deps.redactor,
  });
}
