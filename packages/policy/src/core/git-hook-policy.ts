import { canonicalPath, containsPath, pathApi } from "../paths/paths.ts";
import { GIT_HOOK_CONFIRMATION_REASON } from "./confirmation-reasons.ts";
import type { PolicyTrace } from "./explain.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyResult } from "./types.ts";

export { GIT_HOOK_CONFIRMATION_REASON };

/** Independent literal/scope checks; execution observations never authorize themselves. */
export async function prepareGitHookFacts(
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  analyze: (command: string) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts | undefined> {
  const facts = input.gitHook;
  if (!facts) return;
  const refuse = (reason: string): RequestFacts => ({
    result: trace.result({ ...result, decision: "deny", reason, canRemember: false }, "boundary"),
    incomplete: true,
  });
  const request = input.request;
  if (
    request.category !== "run_command" ||
    facts.status !== "confirmation-required" ||
    facts.reason !== "once_required" ||
    (context.platform !== "darwin" && context.platform !== "linux") ||
    input.gitConfiguration ||
    input.boundary?.location?.target !== "local"
  )
    return refuse("git_hook_unsupported");
  const literal = analyze(request.command).literalCommand;
  if (
    request.command !== "git hook run pre-commit" ||
    literal?.program !== "git" ||
    JSON.stringify(literal.args) !== JSON.stringify(["hook", "run", "pre-commit"]) ||
    request.background ||
    request.outsideSandbox ||
    request.stdin ||
    request.writePaths?.length ||
    facts.cwd !== context.cwd ||
    !facts.hookHash ||
    !facts.programHash ||
    !facts.beforeVersion ||
    !facts.program ||
    !facts.args ||
    facts.hookPath !== pathApi(context.platform).join(context.cwd, ".git", "hooks", "pre-commit")
  )
    return refuse("git_hook_unverified");
  const roots = input.boundary.writeRoots;
  const denied = input.boundary.denyWriteRoots;
  if (
    !roots.some((root) => containsPath(root, context.cwd, context.platform)) ||
    denied.some(
      (root) =>
        containsPath(root, context.cwd, context.platform) ||
        containsPath(context.cwd, root, context.platform),
    )
  )
    return refuse("readonly_workplace");
  const gate =
    ["/usr/bin/true", "/usr/bin/false"].includes(facts.program) && facts.args.length === 0;
  const plist =
    context.platform === "darwin" &&
    facts.program === "/usr/bin/plutil" &&
    facts.args.length === 3 &&
    facts.args[0] === "-lint" &&
    facts.args[1] === "--" &&
    facts.args[2]?.endsWith(".plist");
  if (!gate && !plist) return refuse("git_hook_unverified");
  if (
    roots.some(
      (root) =>
        containsPath(root, "/usr/bin", context.platform) ||
        containsPath(root, "/bin", context.platform),
    )
  )
    return refuse("git_hook_unverified");
  const data = plist ? await canonicalPath(facts.args[2] as string, context) : undefined;
  if (
    data &&
    (!data.exists ||
      !context.roots.some((root) => containsPath(root, data.path, context.platform)) ||
      denied.some((root) => containsPath(root, data.path, context.platform)))
  )
    return refuse("git_hook_unverified");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  result.command = request.command;
  result.cwd = context.cwd;
  result.facts = [
    { kind: "program", value: [facts.program, ...facts.args].map(quote).join(" ") },
    { kind: "read", value: facts.hookPath },
    ...(data ? [{ kind: "read" as const, value: data.path }] : []),
    { kind: "cwd", value: context.cwd },
    { kind: "warning", value: "git_hook_literal_exec", risk: "danger" },
    {
      kind: "warning",
      value: `${facts.hookPath} SHA-256 ${facts.hookHash}; ${facts.program} SHA-256 ${facts.programHash}`,
    },
  ];
  result.analysis = {
    programs: ["git", facts.program],
    commands: [{ program: "git", args: literal.args }],
    reads: [facts.hookPath, ...(data ? [data.path] : [])],
    writes: [context.cwd],
    domains: [],
    network: false,
    incomplete: false,
    warnings: [],
    unknownOptions: [],
    readonly: false,
  };
  trace.step("boundary", "git_hook_literal_exec", "info");
  return { result, incomplete: false, gitHook: true };
}
