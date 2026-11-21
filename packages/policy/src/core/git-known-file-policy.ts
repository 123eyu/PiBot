import { containsPath, pathApi, resolvePath } from "../paths/paths.ts";
import type { PolicyTrace } from "./explain.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PathContext, PolicyResult } from "./types.ts";

/** Known bytes are an exact private recipe; the original file category still determines permission. */
export async function prepareGitKnownFileFacts(
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  trace: PolicyTrace,
): Promise<RequestFacts> {
  const refuse = (reason: string): RequestFacts => ({
    result: trace.result({ ...result, decision: "deny", reason, canRemember: false }, "boundary"),
    incomplete: false,
  });
  const facts = input.gitConfiguration,
    request = input.request,
    adapter = input.gitConfigurationFile;
  if (
    request.category !== "write_file" ||
    !facts ||
    facts.operation !== "known-file" ||
    !adapter ||
    context.platform !== "darwin" ||
    input.boundary?.location?.target !== "local" ||
    facts.status !== "candidate" ||
    facts.reason !== "ordinary_project_candidate" ||
    facts.scope !== "project" ||
    !/^(?:user\.(?:name|email)|remote\..+\.url)$/.test(facts.requestedKey ?? "") ||
    facts.resolvedBranch !== undefined ||
    input.managedGitConfiguration ||
    !facts.beforeVersion ||
    !facts.candidateDigest ||
    !facts.intentDigest ||
    !facts.targetPath ||
    JSON.stringify(facts.changedKeys) !== JSON.stringify([facts.requestedKey]) ||
    adapter.verifyCurrent(facts, request.path) !== "current"
  )
    return refuse("git_configuration_unsupported");
  const target = await resolvePath(request.path, context),
    api = pathApi(context.platform);
  const expected = api.join(context.cwd, ".git", "config");
  const lexical = api.resolve(context.cwd, request.path);
  if (
    target.path !== expected ||
    target.path !== facts.targetPath ||
    lexical !== target.path ||
    !target.root ||
    !input.boundary.writeRoots.some((root) => containsPath(root, target.path, context.platform)) ||
    input.boundary.denyWriteRoots.some(
      (root) =>
        containsPath(root, target.path, context.platform) ||
        containsPath(target.path, root, context.platform),
    )
  )
    return refuse("readonly_workplace");
  input.signal.throwIfAborted();
  if (adapter.verifyCurrent(facts, request.path) !== "current")
    return refuse("git_configuration_unverified");
  result.path = target;
  result.facts = [{ kind: "write", value: target.path }];
  trace.step("boundary", "git_configuration_project_setter", "info");
  return {
    result,
    incomplete: false,
    scope: {
      kind: "workplace",
      root: target.root,
      ...(input.workplaceTopicId ? { topicId: input.workplaceTopicId } : {}),
    },
  };
}
