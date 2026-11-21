import { createHash } from "node:crypto";
import type { HostSshIntent, HostSshOptions } from "./ssh-types.ts";

/*
 * Options a model naturally adds that cannot widen the fixed recipe: Pi Bot already forces batch
 * mode, strict host keys and no TTY / stdin, and the remaining two only shorten the connect wait
 * or quieten diagnostics. Anything else (identity, proxy, forwarding, config) keeps the command
 * out of this recipe. The same rules are mirrored in policy/core/host-ssh-policy.ts, whose digest
 * must equal this one.
 */
const LOG_LEVELS = new Set(["QUIET", "FATAL", "ERROR"]);

/**
 * The alias rule is shared with the settings schema and the host list; a Host line with a
 * wildcard or negation is a pattern, not a name the user can pick.
 */
export const HOST_SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    !HOST_SSH_ALIAS.test(alias) ||
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

export function hostSshIntent(literal: {
  program: string;
  args: readonly string[];
}): HostSshIntent | undefined {
  if (!["ssh", "/usr/bin/ssh"].includes(literal.program)) return undefined;
  const parsed = parseHostSshArgs(literal.args);
  if (!parsed) return undefined;
  return {
    ...parsed,
    digest: hostSshDigest(literal.program, parsed.alias, parsed.remoteCommand, parsed.options),
  };
}
