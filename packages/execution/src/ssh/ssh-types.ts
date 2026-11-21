/** Accepted options that cannot widen the recipe (see ssh-intent.ts). */
export interface HostSshOptions {
  connectTimeout?: number;
  quiet?: boolean;
}
export interface HostSshIntent {
  alias: string;
  remoteCommand: string;
  options: HostSshOptions;
  digest: string;
}

/** These physical snapshots remain inside the brain/execution process. */
export interface HostSshFile {
  path: string;
  kind: "config" | "known-hosts" | "identity" | "program";
  version: string;
  hash?: string;
}

export interface PreparedHostSsh {
  intent: HostSshIntent;
  home: string;
  hostname: string;
  user: string;
  port: number;
  identity: string;
  knownHosts: string;
  /**
   * Effective connect wait: the smaller of the configuration's ConnectTimeout and the intent's
   * (default 15). A longer value in the user's config must not outlive Pi Bot's own timeout.
   */
  connectTimeout: number;
  files: HostSshFile[];
  version: string;
}

export type HostSshReason =
  | "unsupported_syntax"
  | "unsupported_target"
  | "identity_required"
  | "configuration_unavailable"
  | "unsupported_configuration"
  | "configuration_limit"
  | "configuration_changed";

/**
 * Why one host block cannot run the fixed recipe. The settings list shows this instead of the
 * configuration text, which would leak HostName, ports and key paths into the renderer.
 */
export type HostSshUnsupportedReason =
  | "proxy"
  | "match"
  | "include_outside_home"
  | "include_in_workspace"
  /** StrictHostKeyChecking is pinned to yes; accept-new would learn an unverified key. */
  | "strict_host_key"
  /** Any other directive whose value the recipe cannot honour; `option` names which one. */
  | "option"
  /** User is missing, malformed, or is not the one-@ form OrbStack writes. */
  | "user"
  /** An IdentityFile outside ~/.ssh would let the config name a key anywhere on disk. */
  | "identity_outside_ssh"
  | "other";

export class HostSshError extends Error {
  constructor(readonly reason: HostSshReason) {
    super(reason);
  }
}

/**
 * Same outward reason as before, plus the detail the read-only host list needs. Existing callers
 * keep seeing "unsupported_configuration" through `reason`.
 */
export class HostSshConfigError extends HostSshError {
  /** `option` is the directive as written ("ServerAliveInterval"), so the panel can name it. */
  constructor(
    readonly detail: HostSshUnsupportedReason,
    readonly option?: string,
  ) {
    super("unsupported_configuration");
  }
}
