import { containsPath } from "../paths/paths.ts";
import type { PolicyTrace } from "./explain.ts";
import { hostSshDigest, parseHostSshArgs } from "./host-ssh-args.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { CommandAnalysis, EvaluationInput, PathContext, PolicyResult } from "./types.ts";

/**
 * Why a controlled SSH host cannot run, phrased for the model, including the two states the person
 * fixes in settings: the host is not enabled there, or no key is chosen for it.
 */
const reasonCodes: Record<NonNullable<EvaluationInput["hostSsh"]>["reason"], string> = {
  confirmation_required: "host_ssh_unsupported",
  not_enabled: "host_ssh_not_enabled",
  identity_required: "host_ssh_identity_required",
  unsupported_syntax: "host_ssh_unsupported_syntax",
  unsupported_target: "host_ssh_unsupported_target",
  configuration_unavailable: "host_ssh_configuration_unavailable",
  unsupported_configuration: "host_ssh_unsupported_configuration",
  configuration_limit: "host_ssh_unsupported_configuration",
  configuration_changed: "host_ssh_unsupported_configuration",
};

/**
 * The person has to edit one line of ~/.ssh/config, so the refusal names the kind of line to
 * fix. Without this every rejected configuration told the model to look for ProxyJump or Match.
 */
const configDetailCodes: Record<string, string> = {
  strict_host_key: "host_ssh_config_strict_host_key",
  option: "host_ssh_config_option",
  user: "host_ssh_config_user",
  identity_outside_ssh: "host_ssh_config_identity_outside_ssh",
};

/** Only a configuration refusal carries a detail; other reasons stay as they were. */
function hostSshRefusalCode(facts: NonNullable<EvaluationInput["hostSsh"]>) {
  const detail = facts.reason === "unsupported_configuration" ? facts.configDetail : undefined;
  return (detail && configDetailCodes[detail]) || reasonCodes[facts.reason];
}

export function prepareHostSshPolicy(
  input: EvaluationInput,
  context: PathContext,
  result: PolicyResult,
  analyze: (command: string) => CommandAnalysis,
  trace: PolicyTrace,
): RequestFacts | undefined {
  const facts = input.hostSsh;
  if (!facts) return undefined;
  const refuse = (reason: string): RequestFacts => ({
    result: trace.result({ ...result, decision: "deny", reason, canRemember: false }, "boundary"),
    incomplete: true,
  });
  const request = input.request;
  const literal =
    request.category === "run_command" ? analyze(request.command).literalCommand : undefined;
  const parsed = literal ? parseHostSshArgs(literal.args) : undefined;
  if (
    context.platform !== "darwin" ||
    input.boundary?.location?.target !== "local" ||
    request.category !== "run_command" ||
    request.background ||
    request.stdin ||
    request.writePaths?.length ||
    input.gitConfiguration ||
    facts.status !== "candidate" ||
    facts.reason !== "confirmation_required"
  )
    // The specific cause reaches the model: "unsupported" alone sent it to read ~/.ssh instead.
    return refuse(hostSshRefusalCode(facts));
  if (
    !literal ||
    !["ssh", "/usr/bin/ssh"].includes(literal.program) ||
    !parsed ||
    parsed.alias !== facts.alias ||
    !facts.hostname ||
    !facts.port ||
    !facts.resourceVersion ||
    !facts.dependencyCount ||
    facts.intentDigest !==
      hostSshDigest(literal.program, parsed.alias, parsed.remoteCommand, parsed.options)
  )
    return refuse("host_ssh_unverified");
  if (!context.roots.some((root) => containsPath(root, context.cwd, context.platform)))
    return refuse("invalid_workplace");
  if (
    !input.boundary?.writeRoots.some((root) => containsPath(root, context.cwd, context.platform)) ||
    input.boundary.denyWriteRoots.some((root) => containsPath(root, context.cwd, context.platform))
  )
    return refuse("readonly_workplace");
  // The person enabled this host in settings, so the host it resolves to counts as allowed
  // for this recipe only. The general website allowlist stays as narrow as before; the resolved
  // host:port is still shown on the card.
  // The user reviews their entire remote command; host file paths/configuration stay private.
  result.command = request.command;
  result.cwd = context.cwd;
  delete result.commandHome;
  result.facts = [
    { kind: "program", value: "ssh" },
    { kind: "network", value: `${facts.hostname}:${facts.port}` },
    { kind: "warning", value: "host_ssh_static_identity" },
  ];
  // An enabled host is an ordinary run_command decision (ask / always, and YOLO), not a
  // per-call danger card that only a person could answer.
  result.analysis = {
    programs: ["ssh"],
    commands: [{ program: "ssh", args: [parsed.alias, "<remote command>"] }],
    reads: [],
    writes: [],
    domains: [facts.hostname],
    network: true,
    incomplete: false,
    warnings: [],
    unknownOptions: [],
    readonly: false,
  };
  trace.step("boundary", "host_ssh_static_identity", "info");
  return { result, incomplete: false, hostSsh: true };
}
