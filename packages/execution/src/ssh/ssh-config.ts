import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hostSshSnapshot } from "./ssh-deadline.ts";
import { inspectHostSshFile, sshDigest, sshWithin, verifyHostSshFiles } from "./ssh-files.ts";
import { HOST_SSH_ALIAS } from "./ssh-intent.ts";
import {
  HostSshConfigError,
  HostSshError,
  type HostSshFile,
  type HostSshIntent,
  type HostSshUnsupportedReason,
  type PreparedHostSsh,
} from "./ssh-types.ts";

/** Small strict lexer: it does not run shell expansion, percent tokens or environment lookup. */
function words(line: string) {
  const result: string[] = [];
  let value = "",
    quote = false,
    present = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '"') {
      quote = !quote;
      present = true;
    } else if (char === "\\") {
      const next = line[++i];
      if (next === undefined) throw new HostSshConfigError("other");
      value += next;
      present = true;
    } else if (!quote && char === "#") break;
    else if (!quote && /\s/.test(char)) {
      if (present) result.push(value);
      value = "";
      present = false;
    } else {
      value += char;
      present = true;
    }
  }
  if (quote) throw new HostSshConfigError("other");
  if (present) result.push(value);
  return result;
}

function hostMatch(alias: string, patterns: readonly string[]) {
  let matched = false;
  for (const item of patterns) {
    const negative = item.startsWith("!");
    const pattern = negative ? item.slice(1) : item;
    if (!/^[A-Za-z0-9._*?-]{1,128}$/.test(pattern)) throw new HostSshConfigError("other");
    const regex = new RegExp(
      `^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*").replaceAll("?", ".")}$`,
      "i",
    );
    if (regex.test(alias)) {
      if (negative) return false;
      matched = true;
    }
  }
  return matched;
}

/**
 * ConnectTimeout joined this set later: it cannot widen the recipe, and the effective value is
 * still the smaller of the configuration's and Pi Bot's own 15-second default.
 */
const ordinary = new Set([
  "hostname",
  "user",
  "port",
  "identityfile",
  "userknownhostsfile",
  "connecttimeout",
]);
const requiredValues = new Map([
  ["identitiesonly", "yes"],
  ["stricthostkeychecking", "yes"],
  ["batchmode", "yes"],
  ["forwardagent", "no"],
  ["forwardx11", "no"],
  ["forwardx11trusted", "no"],
  ["permitlocalcommand", "no"],
  ["addkeystoagent", "no"],
  ["usekeychain", "no"],
  ["controlmaster", "no"],
  ["controlpersist", "no"],
  ["requesttty", "no"],
  ["canonicalizehostname", "no"],
  ["identityagent", "none"],
]);

/**
 * Where a path from the configuration may live. Include may reach anywhere under the user's
 * home (OrbStack writes ~/.orbstack/ssh/config); keys and known_hosts stay inside ~/.ssh.
 */
function configPath(
  home: string,
  value: string,
  scope: "ssh" | "home",
  /** Reported when a path of this kind lands outside the folder it must stay in. */
  outside: HostSshUnsupportedReason,
) {
  if (
    !value ||
    /[%$`*?[\]\0\r\n]/.test(value) ||
    (value.startsWith("~") && !value.startsWith("~/"))
  )
    throw new HostSshConfigError("other");
  const root = join(home, ".ssh");
  const path = value.startsWith("~/")
    ? resolve(home, value.slice(2))
    : isAbsolute(value)
      ? value
      : resolve(root, value);
  const allowed =
    scope === "home"
      ? sshWithin(home, path) && path !== home
      : sshWithin(root, path) && path !== root;
  if (!allowed) throw new HostSshConfigError(outside);
  return path;
}

/**
 * A rejected directive keeps its directive name so the panel can point at the line to fix. Names
 * that would not read as a directive stay generic rather than echoing arbitrary config text.
 */
function optionError(name: string) {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? new HostSshConfigError("option", name)
    : new HostSshConfigError("other");
}

/**
 * Walks ~/.ssh/config and every include it follows under one set of limits. `onLine` decides what a
 * directive means and returns the block state for the lines after it, so the strict recipe and the
 * settings host list cannot drift apart.
 */
async function walkHostSsh(
  input: {
    userHome: string;
    platform: NodeJS.Platform;
    /** Roots the Bot can write. An Include there would let a writable file become trust input. */
    forbiddenRoots?: readonly string[];
  },
  signal: AbortSignal,
  onLine: (line: { key: string; name: string; tokens: string[] }, active: boolean) => boolean,
  options: { tolerateIncludeErrors?: boolean; cache?: HostSshFileCache } = {},
): Promise<{ home: string; files: HostSshFile[]; includeComplete: boolean }> {
  if (input.platform !== "darwin" || process.platform !== "darwin")
    throw new HostSshError("unsupported_target");
  const home = await realpath(input.userHome);
  const root = join(home, ".ssh");
  const files: HostSshFile[] = [];
  const visited = new Set<string>();
  let totalBytes = 0;
  let active = true;
  // A missing or rejected Include hides aliases that may still have saved settings. The caller
  // must not treat the shortened list as proof that those aliases are gone.
  let includeComplete = true;
  async function visit(path: string, depth: number) {
    signal.throwIfAborted();
    if (depth > 8 || files.length >= 32 || visited.has(path))
      throw new HostSshError("configuration_limit");
    visited.add(path);
    const cached = options.cache?.get(path);
    const inspected = cached ?? (await inspectHostSshFile(path, "config", signal));
    if (!cached) options.cache?.set(path, inspected);
    const { file, text = "" } = inspected;
    files.push(file);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 262_144 || text.includes("\0") || text.includes("\uFFFD"))
      throw new HostSshError("configuration_limit");
    for (const line of text.split(/\r?\n/)) {
      signal.throwIfAborted();
      const tokens = words(line.replace(/^\s*([A-Za-z]+)\s*=\s*/, "$1 "));
      const written = tokens.shift();
      const key = written?.toLowerCase();
      if (!key) continue;
      if (key === "include") {
        // An include only takes effect inside the active block, and its lines inherit that state.
        if (!active) continue;
        if (!tokens.length) throw new HostSshConfigError("other");
        const outer = active;
        for (const include of tokens) {
          try {
            const path = configPath(home, include, "home", "include_outside_home");
            if (input.forbiddenRoots?.some((root) => sshWithin(root, path)))
              throw new HostSshConfigError("include_in_workspace");
            await visit(path, depth + 1);
          } catch (error) {
            // OpenSSH treats a missing Include as empty; a stale include must not hide the rest.
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              includeComplete = false;
              continue;
            }
            // Discovery still lists the hosts it can read; each row reports its own reason.
            if (options.tolerateIncludeErrors && error instanceof HostSshConfigError) {
              includeComplete = false;
              continue;
            }
            throw error;
          }
        }
        // OpenSSH restores the outer Host block after an Include; do not leak the included state.
        active = outer;
        continue;
      }
      active = onLine({ key, name: written ?? key, tokens }, active);
    }
  }
  await visit(join(root, "config"), 0);
  return { home, files, includeComplete };
}

export interface HostSshConfig {
  home: string;
  values: Map<string, string>;
  files: HostSshFile[];
}

/** One list read reuses each file; parsing per alias is cheap, re-reading is not. */
export type HostSshFileCache = Map<string, { file: HostSshFile; text?: string }>;

/** The blocks that apply to one alias: reading only, no key or recipe checks. */
export async function readHostSshConfig(
  input: {
    alias: string;
    userHome: string;
    platform: NodeJS.Platform;
    forbiddenRoots?: readonly string[];
    cache?: HostSshFileCache;
  },
  signal: AbortSignal,
): Promise<HostSshConfig> {
  const values = new Map<string, string>();
  const { home, files } = await walkHostSsh(
    input,
    signal,
    ({ key, name, tokens }, active) => {
      if (key === "match") throw new HostSshConfigError("match");
      if (key === "host") {
        if (!tokens.length) throw new HostSshConfigError("other");
        return hostMatch(input.alias, tokens);
      }
      if (!active) return active;
      if (key === "proxycommand" || key === "proxyjump" || key === "localcommand")
        throw new HostSshConfigError("proxy");
      if (tokens.length !== 1 || !tokens[0]) throw optionError(name);
      const value = tokens[0];
      if (ordinary.has(key)) {
        if (["identityfile", "userknownhostsfile"].includes(key) && values.has(key))
          throw new HostSshConfigError("other");
        // The recipe's own timeout is a ceiling, so an out-of-range value is still a config error
        // instead of silently becoming 15 seconds.
        if (key === "connecttimeout" && !/^\d{1,3}$/.test(value)) throw optionError(name);
        if (key === "connecttimeout" && (Number(value) < 1 || Number(value) > 120))
          throw optionError(name);
        if (!values.has(key)) values.set(key, value);
      } else {
        const required = requiredValues.get(key);
        if (required === undefined) throw optionError(name);
        // Accept-new would let the first connection learn an unverified host key, so this
        // directive gets its own reason and fix instead of "unsupported feature".
        if (key === "stricthostkeychecking") {
          if (value.toLowerCase() !== "yes") throw new HostSshConfigError("strict_host_key");
        } else if (required !== value.toLowerCase()) throw optionError(name);
      }
      return active;
    },
    input.cache ? { cache: input.cache } : {},
  );
  return { home, values, files };
}

export interface HostSshTarget {
  hostname: string;
  user: string;
  port: number;
  /** As written in the configuration; the settings picker supplies one when this is missing. */
  identity?: string;
  knownHosts?: string;
  /** Seconds from the configuration, if any; the recipe takes the smaller of this and its own. */
  connectTimeout?: number;
}

/**
 * OrbStack writes `User lin@kali` for its machines, so one @ is accepted. The value still reaches
 * ssh as a single -l argument, never as a host or option.
 */
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?:@[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;

/** Routing values shared by the recipe and by the status the settings panel shows. */
export function hostSshTarget(values: ReadonlyMap<string, string>, alias: string): HostSshTarget {
  const hostname = values.get("hostname") ?? alias;
  const user = values.get("user");
  const port = Number(values.get("port") ?? "22");
  // The person fixes a User line themselves; say so instead of "unsupported feature".
  if (!user || !SSH_USER.test(user)) throw new HostSshConfigError("user");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(hostname) ||
    !/^\d{1,5}$/.test(values.get("port") ?? "22") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new HostSshConfigError("other");
  // Relative IdentityFile/UserKnownHostsFile semantics depend on OpenSSH's cwd. Require
  // unambiguous host paths; only Include is resolved relative to the SSH configuration root.
  if (
    ![values.get("identityfile"), values.get("userknownhostsfile")].every(
      (value) => value === undefined || isAbsolute(value) || value.startsWith("~/"),
    )
  )
    throw new HostSshConfigError("other");
  return {
    hostname: hostname.toLowerCase(),
    user,
    port,
    identity: values.get("identityfile"),
    knownHosts: values.get("userknownhostsfile"),
    ...(values.has("connecttimeout")
      ? { connectTimeout: Number(values.get("connecttimeout")) }
      : {}),
  };
}

/**
 * Resolves the key material and pins the exact files the recipe will run with. A host whose
 * configuration names no IdentityFile uses the file the person picked in settings; the recipe still
 * pins that single file instead of falling back to OpenSSH's own key order.
 */
export async function resolveHostSshFiles(
  home: string,
  target: HostSshTarget,
  configFiles: readonly HostSshFile[],
  signal: AbortSignal,
  chosenIdentity?: string,
  includePrograms = true,
): Promise<{ identity: string; knownHosts: string; files: HostSshFile[] }> {
  let identity: string;
  if (target.identity) identity = configPath(home, target.identity, "ssh", "identity_outside_ssh");
  // The chosen value is a bare file name; the "~/.ssh/" prefix keeps it under the same
  // inside-~/.ssh check as a configured IdentityFile.
  else if (chosenIdentity)
    identity = configPath(home, join("~/.ssh", chosenIdentity), "ssh", "identity_outside_ssh");
  else throw new HostSshError("identity_required");
  const knownHosts = configPath(home, target.knownHosts ?? "known_hosts", "ssh", "other");
  if (
    identity === knownHosts ||
    configFiles.some((file) => [identity, knownHosts].includes(file.path))
  )
    throw new HostSshConfigError("other");
  const files = [...configFiles];
  const inspected: [string, HostSshFile["kind"]][] = [
    [identity, "identity"],
    [knownHosts, "known-hosts"],
  ];
  // The settings list does not need program hashes; the recipe hashes them again at prepare.
  if (includePrograms)
    inspected.push(
      ["/usr/bin/ssh", "program"],
      ["/usr/bin/nc", "program"],
      ["/bin/sh", "program"],
      ["/bin/cat", "program"],
      ["/bin/bash", "program"],
    );
  for (const [path, kind] of inspected)
    files.push((await inspectHostSshFile(path, kind, signal)).file);
  return { identity, knownHosts, files };
}

/** Host names a literal `ssh 别名` could use: no wildcards, no negations, document order. */
export async function listHostSshNames(
  input: {
    userHome: string;
    platform: NodeJS.Platform;
    forbiddenRoots?: readonly string[];
    cache?: HostSshFileCache;
  },
  signal: AbortSignal,
): Promise<{ home: string; aliases: string[]; complete: boolean }> {
  const home = await realpath(input.userHome);
  // A missing configuration is a normal state for the settings panel, not a read failure.
  if (!(await lstat(join(home, ".ssh", "config")).catch(() => undefined)))
    return { home, aliases: [], complete: true };
  const found = new Set<string>();
  const { includeComplete } = await walkHostSsh(
    input,
    signal,
    ({ key, tokens }) => {
      if (key === "host")
        for (const token of tokens) if (HOST_SSH_ALIAS.test(token)) found.add(token);
      return true;
    },
    { tolerateIncludeErrors: true, ...(input.cache ? { cache: input.cache } : {}) },
  );
  // Same cap as the settings schema; a longer list could never be enabled in full.
  return { home, aliases: [...found].slice(0, 64), complete: includeComplete };
}

export interface HostSshPrepareInput {
  intent: HostSshIntent;
  userHome: string;
  platform: NodeJS.Platform;
  /** File name chosen in settings, used only when the configuration has no IdentityFile. */
  identity?: string;
  /** Workplaces and Bot homes: an Include inside one of them is not user-owned trust input. */
  forbiddenRoots?: readonly string[];
}

async function prepareHostSshCurrent(
  input: HostSshPrepareInput,
  signal: AbortSignal,
): Promise<PreparedHostSsh> {
  try {
    const config = await readHostSshConfig(
      {
        alias: input.intent.alias,
        userHome: input.userHome,
        platform: input.platform,
        ...(input.forbiddenRoots ? { forbiddenRoots: input.forbiddenRoots } : {}),
      },
      signal,
    );
    const target = hostSshTarget(config.values, input.intent.alias);
    const { identity, knownHosts, files } = await resolveHostSshFiles(
      config.home,
      target,
      config.files,
      signal,
      input.identity,
    );
    const plan = {
      intent: input.intent,
      home: config.home,
      hostname: target.hostname,
      user: target.user,
      port: target.port,
      identity,
      knownHosts,
      // A ConnectTimeout line in the config is allowed but never extends Pi Bot's own
      // wait; the shorter of the two wins.
      connectTimeout: Math.min(
        target.connectTimeout ?? Number.POSITIVE_INFINITY,
        input.intent.options.connectTimeout ?? 15,
      ),
      files,
    };
    await verifyHostSshFiles(files, signal);
    return { ...plan, version: sshDigest(plan) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HostSshError) throw error;
    throw new HostSshError("configuration_unavailable");
  }
}

export function prepareHostSsh(
  input: HostSshPrepareInput,
  signal: AbortSignal,
): Promise<PreparedHostSsh> {
  return hostSshSnapshot((current) => prepareHostSshCurrent(input, current), signal);
}

export function verifyPreparedHostSsh(plan: PreparedHostSsh, signal: AbortSignal) {
  return hostSshSnapshot(async (current) => {
    const { version, ...snapshot } = plan;
    if (sshDigest(snapshot) !== version) throw new HostSshError("configuration_changed");
    await verifyHostSshFiles(plan.files, current);
  }, signal);
}
