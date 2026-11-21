import { listenAddress } from "./direct.ts";
export type RunnerCommand =
  | "start"
  | "stop"
  | "status"
  | "pair"
  | "revoke"
  | "tray"
  | "install-service"
  | "uninstall-service";

export type RunnerArguments =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "command";
      command: RunnerCommand;
      name?: string;
      code?: string;
      listen?: string[];
      relay?: string;
      dataDir?: string;
      logLevel?: "info" | "warn" | "error";
      daemon?: boolean;
      json?: boolean;
    };

export function usage() {
  return [
    "Usage: pibot runner <start|stop|status|pair|revoke|tray|install-service|uninstall-service>",
    "  start [--daemon] [--listen <IP:port>]   Linux daemon; listen is repeatable",
    "  pair [<code>]                         paste the computer pairing code",
    "  start|pair [--name <device name>] [--relay <URL>]",
    "  status [--json]",
    "  --data-dir <directory> --log-level <info|warn|error>",
    "  install-service / uninstall-service   Linux systemd user service",
    "",
    "Environment:",
    "  PIBOT_DATA_DIR              runner data directory",
    "  PIBOT_RUNNER_RELAY          relay for pairing (default: wss://relay.pibot.space)",
    "  PIBOT_RUNNER_PASSPHRASE     encrypted-file passphrase for headless startup",
  ].join("\n");
}

export function parseArguments(input: readonly string[]): RunnerArguments {
  const args = input[0] === "runner" ? input.slice(1) : [...input];
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  const command = args[0] as RunnerCommand;
  if (
    ![
      "start",
      "stop",
      "status",
      "pair",
      "revoke",
      "tray",
      "install-service",
      "uninstall-service",
    ].includes(command) ||
    args.length > 40
  )
    throw new TypeError("invalid_arguments");
  const result: Extract<RunnerArguments, { kind: "command" }> = { kind: "command", command };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (command === "pair" && !flag.startsWith("--") && !result.code) {
      if (flag.length > 1152) throw new TypeError("invalid_arguments");
      result.code = flag;
      continue;
    }
    if (flag !== "--listen" && seen.has(flag)) throw new TypeError("invalid_arguments");
    seen.add(flag);
    if (flag === "--daemon" && command === "start") result.daemon = true;
    else if (flag === "--json" && command === "status") result.json = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--") || /[\0\r\n]/.test(value))
        throw new TypeError("invalid_arguments");
      if (flag === "--data-dir") result.dataDir = value;
      else if (flag === "--log-level" && ["info", "warn", "error"].includes(value))
        result.logLevel = value as "info" | "warn" | "error";
      else if (flag === "--relay" && ["start", "pair", "tray", "install-service"].includes(command))
        result.relay = value;
      else if (
        flag === "--name" &&
        ["start", "pair", "tray", "install-service"].includes(command) &&
        value.length <= 200
      )
        result.name = value;
      else if (flag === "--listen" && ["start", "install-service"].includes(command)) {
        result.listen ??= [];
        if (result.listen.length >= 8) throw new TypeError("invalid_arguments");
        result.listen.push(listenAddress(value).address);
      } else throw new TypeError("invalid_arguments");
    }
  }
  return result;
}
