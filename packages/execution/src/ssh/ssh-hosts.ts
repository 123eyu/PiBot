import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type HostSshFileCache,
  hostSshTarget,
  listHostSshNames,
  readHostSshConfig,
  resolveHostSshFiles,
} from "./ssh-config.ts";
import { HostSshConfigError, HostSshError, type HostSshUnsupportedReason } from "./ssh-types.ts";

/** One row of the settings list: status and names only, never HostName, port or key paths. */
export interface HostSshAliasStatus {
  alias: string;
  status: "ready" | "needs_key" | "unsupported";
  reason?: HostSshUnsupportedReason;
  /** Directive named by an `option` reason, so the row can point at the line to remove. */
  option?: string;
  enabled: boolean;
  hasKey: boolean;
  identity?: string;
}

export interface HostSshAliasList {
  hosts: HostSshAliasStatus[];
  identities: string[];
  unavailable?: "unsupported_platform" | "configuration_unavailable" | "configuration_unsupported";
  /** Whether a config file existed, so an empty alias list may prune stored settings. */
  configured?: boolean;
  /**
   * False when an Include was missing or rejected: the list may be missing aliases whose saved
   * settings must therefore be kept.
   */
  complete: boolean;
}

// Names in ~/.ssh that are never a private key, however their mode looks.
const NOT_IDENTITY = new Set(["config", "known_hosts", "known_hosts2"]);

/** Candidate keys: name only, mode 0600, regular files; symlinks and public halves are skipped. */
async function listIdentities(home: string, signal: AbortSignal) {
  const root = join(home, ".ssh");
  // A missing ~/.ssh just means there is nothing to offer yet, not a read failure.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (names.length >= 200) break;
    signal.throwIfAborted();
    if (
      !entry.isFile() ||
      entry.name.endsWith(".pub") ||
      entry.name.startsWith("known_hosts") ||
      NOT_IDENTITY.has(entry.name)
    )
      continue;
    const stat = await lstat(join(root, entry.name)).catch(() => undefined);
    // A key other accounts can read is not offered; ssh itself refuses those too.
    if (!stat || (stat.mode & 0o777) !== 0o600) continue;
    names.push(entry.name);
  }
  return names;
}

/**
 * Hosts of ~/.ssh/config with the state the settings panel shows. Status is judged with the same
 * rules `prepareHostSsh` applies, so a row marked ready is one the recipe can actually run.
 */
export async function listHostSshAliases(
  input: {
    userHome: string;
    platform: NodeJS.Platform;
    hosts: Record<string, { enabled: boolean; identity?: string }>;
    /** Workplaces and Bot homes; an Include there is refused instead of trusted. */
    forbiddenRoots?: readonly string[];
  },
  signal: AbortSignal,
): Promise<HostSshAliasList> {
  if (input.platform !== "darwin")
    return { hosts: [], identities: [], unavailable: "unsupported_platform", complete: false };
  const chosen = new Map(Object.entries(input.hosts));
  // One shared cache: the name walk and every per-alias read see the same file contents once.
  const cache: HostSshFileCache = new Map();
  try {
    // A fresh install has no ~/.ssh/config; that is an empty list, not a retryable read failure.
    const home = await realpath(input.userHome);
    const config = await lstat(join(home, ".ssh", "config")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!config)
      return {
        hosts: [],
        identities: await listIdentities(home, signal),
        configured: false,
        complete: true,
      };
    const { aliases, complete } = await listHostSshNames(
      {
        userHome: input.userHome,
        platform: input.platform,
        ...(input.forbiddenRoots ? { forbiddenRoots: input.forbiddenRoots } : {}),
        cache,
      },
      signal,
    );
    const identities = await listIdentities(home, signal);
    // An empty alias list only means "no hosts left" when there is a config to parse; a missing
    // ~/.ssh/config must not wipe the hosts the person enabled.
    const hosts: HostSshAliasStatus[] = [];
    for (const alias of aliases) {
      signal.throwIfAborted();
      const setting = chosen.get(alias);
      const entry: HostSshAliasStatus = {
        alias,
        status: "unsupported",
        enabled: setting?.enabled ?? false,
        hasKey: false,
      };
      if (setting?.identity) entry.identity = setting.identity;
      try {
        const config = await readHostSshConfig(
          {
            alias,
            userHome: home,
            platform: input.platform,
            ...(input.forbiddenRoots ? { forbiddenRoots: input.forbiddenRoots } : {}),
            cache,
          },
          signal,
        );
        const target = hostSshTarget(config.values, alias);
        entry.hasKey = target.identity !== undefined;
        // A configured or chosen key only counts once it passes the recipe's own checks.
        if (entry.hasKey || setting?.identity) {
          await resolveHostSshFiles(
            config.home,
            target,
            config.files,
            signal,
            target.identity ? undefined : setting?.identity,
            false,
          );
          entry.status = "ready";
        } else entry.status = "needs_key";
      } catch (error) {
        // A broken key or config is this host's permanent state, not a panel-wide read failure.
        if (error instanceof HostSshConfigError) {
          entry.reason = error.detail;
          if (error.option) entry.option = error.option;
        } else if (error instanceof HostSshError) entry.reason = "other";
        else throw error;
        entry.hasKey = false;
      }
      hosts.push(entry);
    }
    return {
      hosts,
      identities,
      configured: (await lstat(join(home, ".ssh", "config")).catch(() => undefined)) !== undefined,
      complete,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HostSshError && error.reason === "unsupported_target")
      return { hosts: [], identities: [], unavailable: "unsupported_platform", complete: false };
    // A symlinked config, an Include limit or another rejected shape will not heal by retrying.
    if (
      error instanceof HostSshError &&
      (error.reason === "unsupported_configuration" || error.reason === "configuration_limit")
    )
      return {
        hosts: [],
        identities: [],
        unavailable: "configuration_unsupported",
        complete: false,
      };
    // A missing or temporarily unreadable file is a retryable panel error, not per-host state.
    return {
      hosts: [],
      identities: [],
      unavailable: "configuration_unavailable",
      complete: false,
    };
  }
}
