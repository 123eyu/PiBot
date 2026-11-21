import { createHash } from "node:crypto";
import { canonicalPath, containsPath, pathApi } from "../paths/paths.ts";
import { GIT_HOOKS_PATH_CONFIRMATION_REASON } from "./confirmation-reasons.ts";
import type { PolicyTrace } from "./explain.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyResult } from "./types.ts";

export { GIT_HOOKS_PATH_CONFIRMATION_REASON };

/** A private current-call adapter validates entities; these serialized facts grant nothing. */
export async function prepareGitHooksPathFacts(
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  analyze: (command: string) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts> {
  const refuse = (): RequestFacts => ({
    result: trace.result(
      { ...result, decision: "deny", reason: "git_configuration_unverified", canRemember: false },
      "boundary",
    ),
    incomplete: false,
  });
  const facts = input.gitConfiguration,
    request = input.request,
    api = pathApi(context.platform);
  if (
    request.category !== "run_command" ||
    request.background ||
    request.stdin ||
    request.writePaths?.length ||
    context.platform !== "darwin" ||
    input.boundary?.location?.target !== "local" ||
    !facts ||
    facts.operation !== "hooks-path" ||
    facts.scope !== "project" ||
    facts.status !== "candidate" ||
    facts.reason !== "hooks_path_candidate" ||
    facts.requestedKey !== "core.hookspath" ||
    facts.resolvedBranch !== undefined ||
    !facts.beforeVersion ||
    !facts.candidateDigest ||
    !facts.hooksPathVersion ||
    !input.gitHooksPath ||
    input.gitConfigurationFile ||
    input.managedGitConfiguration
  )
    return refuse();
  const literal = analyze(request.command).literalCommand;
  if (
    !literal ||
    !/^(?:git|\/.*\/git)$/.test(literal.program) ||
    literal.args.length !== 4 ||
    literal.args[0] !== "config" ||
    literal.args[1] !== "--local" ||
    literal.args[2] !== "core.hooksPath"
  )
    return refuse();
  const value = literal.args[3];
  if (
    !value ||
    value.length > 4096 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
    /[\x00-\x1f\x7f]/.test(value) ||
    !api.isAbsolute(value) ||
    api.resolve(value) !== value
  )
    return refuse();
  const intent = {
    program: literal.program,
    cwd: api.resolve(context.cwd),
    scope: "project",
    key: "core.hookspath",
    value,
  };
  const primary = input.boundary.roots.find(
    (root) => root.id === input.boundary?.primaryId && root.role === "primary",
  );
  if (
    !primary ||
    primary.canonicalPath !== context.cwd ||
    !primary.device ||
    !primary.inode ||
    !input.boundary.writeRoots.includes(context.cwd) ||
    !containsPath(context.cwd, value, context.platform) ||
    facts.intentDigest !== createHash("sha256").update(JSON.stringify(intent)).digest("hex") ||
    facts.targetPath !== api.join(context.cwd, ".git", "config") ||
    JSON.stringify(facts.changedKeys) !== JSON.stringify([intent.key]) ||
    input.boundary.denyWriteRoots.some(
      (root) =>
        containsPath(root, value, context.platform) ||
        containsPath(value, root, context.platform) ||
        containsPath(root, facts.targetPath as string, context.platform),
    ) ||
    input.gitHooksPath.verifyCurrent(facts, request.command) !== "current"
  )
    return refuse();
  const target = await canonicalPath(facts.targetPath, context);
  input.signal.throwIfAborted();
  if (
    target.path !== facts.targetPath ||
    input.gitHooksPath.verifyCurrent(facts, request.command) !== "current"
  )
    return refuse();
  result.command = `git config --local core.hooksPath ${JSON.stringify(value)}`;
  result.cwd = context.cwd;
  delete result.commandHome;
  result.facts = [
    { kind: "program", value: "git" },
    { kind: "write", value: target.path },
    { kind: "warning", value: "git_hooks_path_setter" },
  ];
  result.analysis = {
    programs: ["git"],
    commands: [{ program: "git", args: ["config", "--local", "core.hooksPath", value] }],
    reads: [],
    writes: [target.path],
    domains: [],
    network: false,
    incomplete: false,
    warnings: [],
    unknownOptions: [],
    readonly: false,
  };
  return { result, incomplete: false, gitConfiguration: "hooks-path" };
}
