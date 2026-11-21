import { createHash } from "node:crypto";

const branchName = (value: string) =>
  value.length > 0 &&
  value.length <= 256 &&
  value !== "HEAD" &&
  value !== "@" &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  !/[\s~^:?*[\\]/.test(value) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.startsWith("-") &&
  !value.endsWith(".") &&
  value.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"));

/** Independent pure mirror of the fixed recipe. resolvedBranch comes only from execution facts. */
export function gitUpstreamPolicyIntent(
  literal: { program: string; args: readonly string[] },
  cwd: string,
  resolvedBranch: string | undefined,
) {
  if (literal.args[0] !== "branch" || !resolvedBranch || !branchName(resolvedBranch))
    return undefined;
  const args = literal.args.slice(1),
    option = args.shift();
  if (!(option === "--set-upstream-to" || option?.startsWith("--set-upstream-to=")))
    return undefined;
  const optionStyle = option === "--set-upstream-to" ? ("separate" as const) : ("equals" as const);
  const target =
    optionStyle === "separate" ? args.shift() : option.slice("--set-upstream-to=".length);
  const split = target?.indexOf("/") ?? -1,
    name = target?.slice(0, split),
    upstreamBranch = target?.slice(split + 1),
    localBranch = args[0];
  if (
    args.length > 1 ||
    !name ||
    !upstreamBranch ||
    !branchName(name) ||
    !branchName(upstreamBranch) ||
    (localBranch !== undefined && (!branchName(localBranch) || localBranch !== resolvedBranch))
  )
    return undefined;
  const intent = {
    program: literal.program,
    cwd,
    scope: "project" as const,
    key: `branch.${localBranch ?? "HEAD"}.remote`,
    value: name,
    recipe: {
      kind: "branch-upstream" as const,
      name,
      upstreamBranch,
      ...(localBranch ? { localBranch } : {}),
      optionStyle,
    },
  };
  const key = `branch.${resolvedBranch}.remote`;
  return {
    ...intent,
    key,
    resolvedBranch,
    digest: createHash("sha256").update(JSON.stringify(intent)).digest("hex"),
    changedKeys: [key, `branch.${resolvedBranch}.merge`],
  };
}
