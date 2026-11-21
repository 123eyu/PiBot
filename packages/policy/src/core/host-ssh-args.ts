import { createHash } from "node:crypto";
/** Mirrors execution/src/ssh/ssh-intent.ts exactly; policy cannot import execution (layering). */
export interface HostSshOptions {
  connectTimeout?: number;
  quiet?: boolean;
}

/*
 * Options a model naturally adds that cannot widen the fixed recipe: Pi Bot already forces batch
 * mode, strict host keys and no TTY / stdin, and the remaining two only shorten the connect wait
 * or quieten diagnostics. Anything else (identity, proxy, forwarding, config) keeps the command
 * out of this recipe. The same rules are mirrored in policy/core/host-ssh-policy.ts, whose digest
 * must equal this one. Keep both files identical in rules.
 */
const LOG_LEVELS = new Set(["QUIET", "FATAL", "ERROR"]);

function option(key: string, value: string, options: HostSshOptions): boolean {
  const name = key.toLowerCase();
  if (name === "batchmode") return value.toLowerCase() === "yes";
  if (name === "stricthostkeychecking") return value.toLowerCase() === "yes";
  if (name === "connecttimeout") {
    if (!/^\d{1,3}$/.test(value)) return false;
    const seconds = Number(value);
    if (seconds < 1 || seconds > 120) return false;
    options.connectTimeout = seconds;
    return true;
  }
  if (name === "loglevel") {
    if (!LOG_LEVELS.has(value.toUpperCase())) return false;
    options.quiet = true;
    return true;
  }
  return false;
}

/** Leading options, then exactly ALIAS and one remote command argument. */
export function parseHostSshArgs(args: readonly string[]) {
  const options: HostSshOptions = {};
  let index = 0;
  while (index < args.length && (args[index] as string).startsWith("-")) {
    const arg = args[index] as string;
    if (arg === "-T" || arg === "-n") index += 1;
    else if (arg === "-q") {
      options.quiet = true;
      index += 1;
    } else if (arg === "-o" || arg.startsWith("-o")) {
      const text = arg === "-o" ? args[index + 1] : arg.slice(2);
      const match = text ? /^([A-Za-z]+)[= ]([^\s]+)$/.exec(text) : null;
      if (!match || !option(match[1] as string, match[2] as string, options)) return undefined;
      index += arg === "-o" ? 2 : 1;
    } else return undefined;
    if (index > 12) return undefined;
  }
  const rest = args.slice(index);
  const [alias, remoteCommand] = rest;
  if (
    rest.length !== 2 ||
    !alias ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias) ||
    !remoteCommand ||
    remoteCommand.length > 16_384 ||
    /[\0\r\n]/.test(remoteCommand) ||
    remoteCommand.trimStart().startsWith("-")
  )
    return undefined;
  return { alias, remoteCommand, options };
}

/** Digest of the call shape the user confirms; options are part of it. */
export function hostSshDigest(
  program: string,
  alias: string,
  remoteCommand: string,
  options: HostSshOptions,
) {
  const shape: unknown[] = [program, alias, remoteCommand];
  if (options.connectTimeout !== undefined || options.quiet)
    shape.push({ connectTimeout: options.connectTimeout ?? null, quiet: options.quiet === true });
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
