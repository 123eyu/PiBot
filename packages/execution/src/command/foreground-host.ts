import type { Writable } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { prepareSandboxHost } from "../sandbox/sandbox-host-launch.ts";
import { executeProcess } from "./process.ts";

/** The same output/tree owner as ordinary commands; SRT state lives only in this child host. */
export async function executeHostedCommand(input: {
  hostSsh?: import("../ssh/ssh-command.ts").HostSshCommand;
  options: ExecOptions;
  config: SandboxRuntimeConfig;
  allowAll: boolean;
  privateNetworkHosts?: string[];
  command: string;
  commandId: string;
  commandText?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  log: Writable;
  onOutput?: (text: string) => void;
  onProcess?: (control: import("./process.ts").ProcessControl) => void;
  prepared(): Promise<void>;
  dispatch?(): void;
}) {
  const host = await prepareSandboxHost({
    tempDir: input.options.tempDir,
    systemHome: input.options.systemHome,
    commandEnv: input.env,
    args: input.options.helperArgs?.sandbox,
  });
  let drained = true;
  try {
    input.signal.throwIfAborted();
    return await executeProcess({
      shell: host.executable,
      args: host.args,
      cwd: input.cwd,
      env: host.env,
      platform: input.options.platform,
      signal: input.signal,
      log: input.log,
      redactor: input.options.redactor,
      onOutput: input.onOutput,
      onProcess: input.onProcess,
      host: {
        payload: host.payload({
          ...(input.hostSsh ? { hostSsh: input.hostSsh } : {}),
          config: input.config,
          allowAll: input.allowAll,
          ...(input.privateNetworkHosts !== undefined
            ? { privateNetworkHosts: input.privateNetworkHosts }
            : {}),
          command: input.command,
          commandId: input.commandId,
          ...(input.commandText ? { commandText: input.commandText } : {}),
          cwd: input.cwd,
          shell: input.env.SHELL as string,
          env: input.env,
          foreground: true,
        }),
        prepared: input.prepared,
        dispatch: input.dispatch,
      },
    });
  } catch (error) {
    drained = !(error instanceof ExecError && error.reason === "cleanup_failed");
    throw error;
  } finally {
    if (drained) await host.cleanup();
  }
}
