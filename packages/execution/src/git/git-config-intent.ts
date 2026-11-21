import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export type GitConfigurationReason =
  | "not_config_setter"
  | "unsupported_syntax"
  | "unsupported_program"
  | "protected_scope"
  | "unsupported_key"
  | "invalid_value"
  | "credential_value"
  | "shared_metadata"
  | "scope_unverified"
  | "changed"
  | "includes_unknown"
  | "candidate_failed"
  | "global_confirmation_required"
  | "sensitive_project_confirmation_required"
  | "ordinary_project_candidate"
  | "managed_branch_candidate"
  | "hooks_path_candidate";
export interface GitConfigurationIntent {
  program: string;
  cwd: string;
  scope: "project" | "global";
  key: string;
  value: string;
  recipe?:
    | { kind: "remote-add" | "remote-set-url"; name: string }
    | {
        kind: "branch-upstream";
        name: string;
        upstreamBranch: string;
        localBranch?: string;
        optionStyle: "equals" | "separate";
      };
  /** Execution-resolved local ref; absent from the original literal digest. */
  resolvedBranch?: string;
  digest: string;
}
export interface GitConfigurationIntentResult {
  intent?: GitConfigurationIntent;
  reason: GitConfigurationReason;
  scope?: "project" | "global" | "system";
}
export function gitConfigurationDigest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new TypeError("Git configuration digest requires serializable data");
  return createHash("sha256").update(serialized).digest("hex");
}

/** Only fixed recipe-owned keys are derived here; callers cannot supply an arbitrary batch. */
export function gitConfigurationChanges(intent: GitConfigurationIntent) {
  return [
    { key: intent.key, value: intent.value },
    ...(intent.recipe?.kind === "remote-add"
      ? [
          {
            key: `remote.${intent.recipe.name}.fetch`,
            value: `+refs/heads/*:refs/remotes/${intent.recipe.name}/*`,
          },
        ]
      : intent.recipe?.kind === "branch-upstream"
        ? [
            {
              key: `branch.${intent.resolvedBranch ?? intent.recipe.localBranch}.merge`,
              value: `refs/heads/${intent.recipe.upstreamBranch}`,
            },
          ]
        : []),
  ];
}

export function gitConfigurationArguments(intent: GitConfigurationIntent): string[] {
  if (intent.recipe?.kind === "branch-upstream") {
    const recipe = intent.recipe,
      upstream = `${recipe.name}/${recipe.upstreamBranch}`;
    return [
      "branch",
      ...(recipe.optionStyle === "equals"
        ? [`--set-upstream-to=${upstream}`]
        : ["--set-upstream-to", upstream]),
      ...(recipe.localBranch ? [recipe.localBranch] : []),
    ];
  }
  if (intent.recipe)
    return [
      "remote",
      intent.recipe.kind === "remote-add" ? "add" : "set-url",
      intent.recipe.name,
      intent.value,
    ];
  return [
    "config",
    intent.scope === "global" ? "--global" : "--local",
    intent.key === "core.hookspath" ? "core.hooksPath" : intent.key,
    intent.value,
  ];
}

const control = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const refName = (value: string) =>
  value.length > 0 &&
  value.length <= 256 &&
  !control(value) &&
  !/[\s~^:?*[\\]/.test(value) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.startsWith("-") &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.endsWith(".lock") &&
  !value.endsWith(".");
const remoteName = (value: string) =>
  refName(value) &&
  value.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
export const gitConfigurationBranchName = (value: string) =>
  remoteName(value) && value !== "HEAD" && value !== "@";
function ordinaryKey(key: string): string | undefined {
  if (/^user\.(?:name|email)$/i.test(key)) return key.toLowerCase();
  const match = /^(remote|branch)\.(.+)\.(url|fetch|pushurl|remote|merge|pushremote)$/i.exec(key);
  if (!match?.[1] || !match[2] || !match[3] || !refName(match[2])) return undefined;
  const section = match[1].toLowerCase(),
    variable = match[3].toLowerCase();
  if (
    !(
      section === "remote" ? ["url", "fetch", "pushurl"] : ["remote", "merge", "pushremote"]
    ).includes(variable)
  )
    return undefined;
  return `${section}.${match[2]}.${variable}`;
}
/**
 * Mirrors protocol-base's sensitive vocabulary (execution has no workspace dependencies). An
 * approved edit of these keys never grants permission to run the program they name.
 */
export function sensitiveGitConfigurationKey(key: string): string | undefined {
  if (/^(?:core\.sshcommand|credential\.helper)$/i.test(key)) return key.toLowerCase();
  const match = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key);
  if (!match?.[1] || !match[2] || !refName(match[1])) return undefined;
  return `filter.${match[1]}.${match[2].toLowerCase()}`;
}

/** Mandatory per-call confirmation; mirrors protocol-base gitConfigurationNeedsConfirmation. */
export function gitConfigurationRequiresConfirmation(intent: GitConfigurationIntent): boolean {
  return (
    intent.scope === "global" ||
    (!intent.recipe && sensitiveGitConfigurationKey(intent.key) === intent.key)
  );
}
function valueReason(key: string, value: string): GitConfigurationReason | undefined {
  if (!value || value.length > 4096 || control(value)) return "invalid_value";
  if (key.startsWith("remote.") && /\.(?:url|pushurl)$/.test(key)) {
    const protocol = /^([a-z][a-z\d+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
    if (protocol) {
      if (!["http", "https", "ssh", "git", "file"].includes(protocol)) return "invalid_value";
      try {
        const url = new URL(value);
        if (url.username || url.password) return "credential_value";
      } catch {
        return "invalid_value";
      }
    }
    if (/^[^/:\\\s]+::|\s/i.test(value)) return "invalid_value";
  }
  if (
    key.startsWith("branch.") &&
    /\.(?:remote|pushremote)$/.test(key) &&
    value !== "." &&
    !refName(value)
  )
    return "invalid_value";
  if (
    key.startsWith("branch.") &&
    key.endsWith(".merge") &&
    (!value.startsWith("refs/heads/") || !refName(value))
  )
    return "invalid_value";
  return undefined;
}

export function hooksPathValue(value: string) {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
    !/[\x00-\x1f\x7f]/.test(value) &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

/** Consumes the existing AST's single literal argv; never unwraps scripts or grants a command. */
export function gitConfigurationIntent(
  literal: { program: string; args: readonly string[] },
  cwd: string,
): GitConfigurationIntentResult {
  if (!/^(?:git|.*[/\\]git(?:\.exe)?)$/.test(literal.program))
    return { reason: "not_config_setter" };
  const remote = literal.args[0] === "remote" && ["add", "set-url"].includes(literal.args[1] ?? "");
  const upstream =
    literal.args[0] === "branch" &&
    literal.args.some((arg) => arg === "--set-upstream-to" || arg.startsWith("--set-upstream-to="));
  if (literal.args[0] !== "config" && !remote && !upstream) return { reason: "not_config_setter" };
  if (!isAbsolute(cwd) || cwd.includes("\0")) return { reason: "unsupported_syntax" };
  if (upstream) {
    const args = literal.args.slice(1),
      option = args.shift();
    const optionStyle =
      option === "--set-upstream-to" ? ("separate" as const) : ("equals" as const);
    const target =
      optionStyle === "separate" ? args.shift() : option?.slice("--set-upstream-to=".length);
    const split = target?.indexOf("/") ?? -1,
      name = target?.slice(0, split),
      branch = target?.slice(split + 1),
      localBranch = args[0];
    if (
      !(option === "--set-upstream-to" || option?.startsWith("--set-upstream-to=")) ||
      args.length > 1 ||
      !name ||
      !branch ||
      !gitConfigurationBranchName(name) ||
      !gitConfigurationBranchName(branch) ||
      (localBranch !== undefined && !gitConfigurationBranchName(localBranch))
    )
      return { reason: "unsupported_syntax", scope: "project" };
    const intent = {
      program: literal.program,
      cwd: resolve(cwd),
      scope: "project" as const,
      key: `branch.${localBranch ?? "HEAD"}.remote`,
      value: name,
      recipe: {
        kind: "branch-upstream" as const,
        name,
        upstreamBranch: branch,
        ...(localBranch ? { localBranch } : {}),
        optionStyle,
      },
    };
    return {
      intent: { ...intent, digest: gitConfigurationDigest(intent) },
      reason: "ordinary_project_candidate",
      scope: "project",
    };
  }
  if (remote) {
    const [_, operation, name, value] = literal.args;
    if (literal.args.length !== 4 || !name || !remoteName(name) || value === undefined)
      return { reason: "unsupported_syntax", scope: "project" };
    const key = `remote.${name}.url`;
    const reason = valueReason(key, value);
    if (reason) return { reason, scope: "project" };
    if (value.startsWith("-")) return { reason: "invalid_value", scope: "project" };
    const intent = {
      program: literal.program,
      cwd: resolve(cwd),
      scope: "project" as const,
      key,
      value,
      recipe: {
        kind: operation === "add" ? ("remote-add" as const) : ("remote-set-url" as const),
        name,
      },
    };
    return {
      intent: { ...intent, digest: gitConfigurationDigest(intent) },
      reason: "ordinary_project_candidate",
      scope: "project",
    };
  }
  if (
    literal.args.length === 4 &&
    literal.args[0] === "config" &&
    literal.args[1] === "--local" &&
    literal.args[2] === "core.hooksPath"
  ) {
    const value = literal.args[3] as string;
    if (!hooksPathValue(value)) return { reason: "invalid_value", scope: "project" };
    const intent = {
      program: literal.program,
      cwd: resolve(cwd),
      scope: "project" as const,
      key: "core.hookspath",
      value,
    };
    return {
      intent: { ...intent, digest: gitConfigurationDigest(intent) },
      reason: "hooks_path_candidate",
      scope: "project",
    };
  }
  const args = [...literal.args.slice(1)];
  let scope: "project" | "global" = "project";
  if (args[0] === "--system") return { reason: "protected_scope", scope: "system" };
  if (args[0] === "--global" || args[0] === "--local")
    scope = args.shift() === "--global" ? "global" : "project";
  if (args.length !== 2 || args[0]?.startsWith("-")) return { reason: "unsupported_syntax", scope };
  const sensitive = sensitiveGitConfigurationKey(args[0] ?? "");
  const key = ordinaryKey(args[0] ?? "") ?? sensitive;
  if (!key || (scope === "global" && !/^user\.(?:name|email)$/.test(key)))
    return { reason: scope === "global" ? "protected_scope" : "unsupported_key", scope };
  const value = args[1] as string;
  const reason = valueReason(key, value);
  if (reason) return { reason, scope };
  const intent = { program: literal.program, cwd: resolve(cwd), scope, key, value };
  return {
    intent: { ...intent, digest: gitConfigurationDigest(intent) },
    reason:
      scope === "global"
        ? "global_confirmation_required"
        : sensitive
          ? "sensitive_project_confirmation_required"
          : "ordinary_project_candidate",
    scope,
  };
}
