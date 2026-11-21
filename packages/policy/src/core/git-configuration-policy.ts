import { createHash } from "node:crypto";
import { normalizeSensitiveGitConfigurationKey } from "@pibot/protocol-base";
import { canonicalPath, containsPath, pathApi } from "../paths/paths.ts";
import { protectedPaths } from "../paths/protected-paths.ts";
import { GIT_CONFIGURATION_CONFIRMATION_REASON } from "./confirmation-reasons.ts";
import type { PolicyTrace } from "./explain.ts";
import { gitUpstreamPolicyIntent } from "./git-upstream-policy.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyResult } from "./types.ts";

export { GIT_CONFIGURATION_CONFIRMATION_REASON };

export function selectedGitConfiguration(input: EvaluationInput): boolean {
  return !!input.gitConfiguration && input.gitConfiguration.status !== "not-applicable";
}

export function unsupportedGitConfigurationTarget(input: EvaluationInput, context: PathContext) {
  return (
    context.platform === "win32" ||
    (input.boundary?.location !== undefined && input.boundary.location.target !== "local")
  );
}

const control = (text: string) =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const refName = (text: string) =>
  text.length > 0 &&
  text.length <= 256 &&
  !control(text) &&
  !/[\s~^:?*[\\]/.test(text) &&
  !text.includes("..") &&
  !text.includes("@{") &&
  !text.startsWith("-") &&
  !text.startsWith("/") &&
  !text.endsWith("/") &&
  !text.endsWith(".lock") &&
  !text.endsWith(".");
const remoteName = (text: string) =>
  refName(text) &&
  text.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"));

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

function ordinaryValue(key: string, value: string): boolean {
  if (!value || value.length > 4096 || control(value)) return false;
  if (key.startsWith("remote.") && /\.(?:url|pushurl)$/.test(key)) {
    if (/^[^/:\\\s]+::|\s/i.test(value)) return false;
    const protocol = /^([a-z][a-z\d+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
    if (protocol) {
      if (!["http", "https", "ssh", "git", "file"].includes(protocol)) return false;
      try {
        const url = new URL(value);
        if (url.username || url.password) return false;
      } catch {
        return false;
      }
    }
  }
  if (
    key.startsWith("branch.") &&
    /\.(?:remote|pushremote)$/.test(key) &&
    value !== "." &&
    !refName(value)
  )
    return false;
  return (
    !key.startsWith("branch.") ||
    !key.endsWith(".merge") ||
    (value.startsWith("refs/heads/") && refName(value))
  );
}

function intentFor(input: EvaluationInput, context: PathContext, analysis: CommandAnalysis) {
  if (
    input.request.category !== "run_command" ||
    input.request.background ||
    input.request.stdin ||
    input.request.writePaths?.length
  )
    return undefined;
  const literal = analysis.literalCommand;
  if (!literal || !/^(?:git|\/.*\/git)$/.test(literal.program)) return undefined;
  if (literal.args[0] === "branch")
    return gitUpstreamPolicyIntent(
      literal,
      pathApi(context.platform).resolve(context.cwd),
      input.gitConfiguration?.resolvedBranch,
    );
  if (input.gitConfiguration?.resolvedBranch !== undefined) return undefined;
  const remote = literal.args[0] === "remote" && ["add", "set-url"].includes(literal.args[1] ?? "");
  if (literal.args[0] !== "config" && !remote) return undefined;
  let recipe: { kind: "remote-add" | "remote-set-url"; name: string } | undefined;
  const args = literal.args.slice(remote ? 2 : 1);
  let scope: "project" | "global" = "project";
  if (!remote && (args[0] === "--local" || args[0] === "--global"))
    scope = args.shift() === "--global" ? "global" : "project";
  if (args.length !== 2 || args[0]?.startsWith("-")) return undefined;
  if (remote) {
    const name = args[0];
    if (!name || !remoteName(name) || args[1]?.startsWith("-")) return undefined;
    recipe = { kind: literal.args[1] === "add" ? "remote-add" : "remote-set-url", name };
  }
  const sensitive = remote ? undefined : normalizeSensitiveGitConfigurationKey(args[0] ?? "");
  const key = ordinaryKey(remote ? `remote.${args[0]}.url` : (args[0] ?? "")) ?? sensitive,
    value = args[1];
  if (
    !key ||
    value === undefined ||
    (sensitive ? !value || value.length > 4096 || control(value) : !ordinaryValue(key, value)) ||
    (scope === "global" && !/^user\.(?:name|email)$/.test(key))
  )
    return undefined;
  const intent = {
    program: literal.program,
    cwd: pathApi(context.platform).resolve(context.cwd),
    scope,
    key,
    value,
    ...(recipe ? { recipe } : {}),
  };
  return {
    ...intent,
    sensitive: sensitive !== undefined,
    digest: createHash("sha256").update(JSON.stringify(intent)).digest("hex"),
    changedKeys: [key, ...(recipe?.kind === "remote-add" ? [`remote.${recipe.name}.fetch`] : [])],
  };
}

/** Constructs only controlled-operation facts; raw command analysis never grants a config write. */
export async function prepareGitConfigurationFacts(
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  analyze: (command: string) => CommandAnalysis,
  trace: PolicyTrace,
): Promise<RequestFacts | undefined> {
  if (!selectedGitConfiguration(input)) return undefined;
  const refuse = (reason: string): RequestFacts => ({
    result: trace.result({ ...result, decision: "deny", reason, canRemember: false }, "boundary"),
    incomplete: false,
  });
  if (unsupportedGitConfigurationTarget(input, context))
    return refuse("git_configuration_unsupported");
  const facts = input.gitConfiguration;
  if (!facts || input.request.category !== "run_command")
    return refuse("git_configuration_unverified");
  if (facts.status === "unsupported" || facts.scope === "system")
    return refuse("git_configuration_unsupported");
  const intent = intentFor(input, context, analyze(input.request.command));
  if (
    !intent ||
    facts.scope !== intent.scope ||
    facts.requestedKey !== intent.key ||
    facts.intentDigest !== intent.digest ||
    JSON.stringify(facts.changedKeys) !== JSON.stringify(intent.changedKeys) ||
    !facts.targetPath ||
    !facts.beforeVersion
  )
    return refuse("git_configuration_unverified");
  const project = intent.scope === "project";
  // Only the plain `git config` intent can carry a sensitive key; upstream/remote recipes cannot.
  const sensitive = "sensitive" in intent && intent.sensitive === true;
  const managed = input.managedGitConfiguration;
  const shared = facts.reason === "managed_branch_candidate";
  if (shared || managed) {
    const b = managed?.binding,
      literal = analyze(input.request.command).literalCommand;
    if (
      !shared ||
      !managed ||
      !b ||
      context.platform !== "darwin" ||
      !project ||
      b.purpose !== "af8-own-branch-pushremote" ||
      !literal ||
      literal.args.length !== 4 ||
      literal.args[0] !== "config" ||
      literal.args[1] !== "--local" ||
      !refName(b.branch) ||
      !remoteName(intent.value) ||
      intent.value === "." ||
      intent.key !== `branch.${b.branch}.pushremote` ||
      intent.key !== b.key ||
      intent.digest !== b.intentDigest ||
      facts.beforeVersion !== b.beforeVersion ||
      facts.targetPath !== b.targetPath ||
      b.call.botId !== input.botId ||
      !b.call.runId ||
      !b.call.toolCallId ||
      !b.call.topicId ||
      b.call.topicId !== b.call.conversationId ||
      (!b.call.groupId && input.workplaceTopicId !== b.call.topicId) ||
      b.cwd !== context.cwd ||
      b.primary.path !== context.cwd ||
      !input.boundary?.roots.some(
        (root) =>
          root.role === "primary" &&
          root.canonicalPath === b.primary.path &&
          root.device === b.primary.device &&
          root.inode === b.primary.inode,
      ) ||
      b.common.path !== pathApi(context.platform).join(b.source.path, ".git") ||
      b.targetPath !== pathApi(context.platform).join(b.common.path, "config") ||
      managed.verifyCurrent(b) !== "current"
    )
      return refuse("git_configuration_unverified");
    result.canRemember = false;
  }
  if (sensitive && (shared || managed || facts.operation !== undefined))
    return refuse("git_configuration_unverified");
  if (
    project
      ? facts.status !== (sensitive ? "confirmation-required" : "candidate") ||
        facts.reason !==
          (shared
            ? "managed_branch_candidate"
            : sensitive
              ? "sensitive_project_confirmation_required"
              : "ordinary_project_candidate") ||
        !facts.candidateDigest
      : facts.status !== "confirmation-required" ||
        facts.reason !== "global_confirmation_required" ||
        facts.candidateDigest !== undefined
  )
    return refuse("git_configuration_unverified");
  const api = pathApi(context.platform);
  if (!api.isAbsolute(facts.targetPath)) return refuse("git_configuration_unverified");
  const target = await canonicalPath(facts.targetPath, context);
  if (target.path !== facts.targetPath) return refuse("git_configuration_unverified");
  const denied =
    input.boundary?.denyWriteRoots ??
    (await Promise.all(
      input.workplace.folders
        .filter((folder) => folder.role === "readonly")
        .map(async (folder) => (await canonicalPath(folder.path, context)).path),
    ));
  const roots =
    input.boundary?.writeRoots ?? context.roots.filter((root) => !denied.includes(root));
  const inside = (path: string) => roots.some((root) => containsPath(root, path, context.platform));
  const blocked = (path: string) =>
    denied.some(
      (root) =>
        containsPath(root, path, context.platform) || containsPath(path, root, context.platform),
    );
  if (
    !inside(context.cwd) ||
    denied.some((root) => containsPath(root, context.cwd, context.platform)) ||
    blocked(target.path)
  )
    return refuse("readonly_workplace");
  if (project) {
    if (
      (!shared && !inside(target.path)) ||
      api.basename(target.path) !== "config" ||
      api.basename(api.dirname(target.path)) !== ".git"
    )
      return refuse("git_configuration_unverified");
  } else {
    const hostHome = context.protectionHome;
    if (!hostHome || !api.isAbsolute(hostHome)) return refuse("git_configuration_unverified");
    const home = (await canonicalPath(hostHome, context)).path;
    const profile =
      target.path === api.join(home, ".gitconfig") ||
      (containsPath(home, target.path, context.platform) &&
        api.basename(target.path) === "config" &&
        api.basename(api.dirname(target.path)) === "git");
    if (!profile || (await protectedPaths(context, [])).covers(target.path))
      return refuse("git_configuration_unverified");
  }
  // Values and config bodies never enter approval persistence or command audit projections.
  const summary = `git config ${project ? "--local" : "--global"} ${intent.key} <value omitted>`;
  const warning = sensitive
    ? "git_configuration_sensitive_project_setter"
    : project
      ? "git_configuration_project_setter"
      : "git_configuration_global_setter";
  result.command = summary;
  result.cwd = context.cwd;
  delete result.commandHome;
  result.facts = [
    { kind: "program", value: "git" },
    { kind: "write", value: target.path },
    { kind: "warning", value: warning },
  ];
  result.analysis = {
    programs: ["git"],
    commands: [
      {
        program: "git",
        args: ["config", project ? "--local" : "--global", intent.key, "<value omitted>"],
      },
    ],
    reads: [],
    writes: [target.path],
    domains: [],
    network: false,
    incomplete: false,
    warnings: [],
    unknownOptions: [],
    readonly: false,
  };
  trace.step("boundary", warning, "info");
  const root = shared
    ? managed?.binding.primary.path
    : roots
        .filter(
          (entry) =>
            containsPath(entry, context.cwd, context.platform) &&
            containsPath(entry, target.path, context.platform),
        )
        .sort((a, b) => b.length - a.length)[0];
  return {
    result,
    incomplete: false,
    gitConfiguration: sensitive ? "sensitive-project" : intent.scope,
    // A mandatory once-only confirmation offers nothing to remember.
    ...(project && !sensitive && root
      ? {
          scope: {
            kind: "programs" as const,
            programs: ["git"],
            root,
            ...(input.workplaceTopicId && input.boundary?.writeRoots.includes(root)
              ? { topicId: input.workplaceTopicId }
              : {}),
          },
        }
      : {}),
  };
}
