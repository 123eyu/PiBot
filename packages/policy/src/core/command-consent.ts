import { isNetworkProgram } from "../targets/private-network.ts";
import type { PolicyTrace } from "./explain.ts";
import { effectiveLevel } from "./levels.ts";
import type { CommandAnalysis, EvaluationInput, PolicyResult } from "./types.ts";

// A script's network use is opaque. Automatic execution uses a bounded list even with allowAll.
// The local sandbox checks private-network consent separately from this domain list.
export const COMMAND_PACKAGE_DOMAINS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

export function commandNetwork(input: EvaluationInput) {
  const local = !input.boundary?.location || input.boundary.location.target === "local";
  return {
    allowAll: false,
    domains: [
      ...new Set([
        ...(input.settings.network.allowAll ? COMMAND_PACKAGE_DOMAINS : []),
        ...input.settings.network.domains.filter(
          (domain) => local || COMMAND_PACKAGE_DOMAINS.some((host) => host === domain),
        ),
      ]),
    ],
  };
}

export function commandConfirmation(input: EvaluationInput, result: PolicyResult) {
  const request = input.request;
  const analysis = result.analysis;
  if (request.category !== "run_command" || !analysis) return undefined;
  const install = analysis.commands.some(({ program, args }) => {
    const name = program
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, "")
      .toLowerCase();
    const installer =
      /^(?:npm|pnpm|yarn|bun|pip\d*(?:\.\d+)?|uv|uvx|pipx|poetry|pdm|brew|apt|apt-get|dnf|yum|pacman|apk|conda|mamba|gem|cargo|go|winget|choco|scoop)$/;
    // Only the package manager's own subcommand counts: everything after `exec` / `run` / `--`
    // belongs to the program being run (`pnpm exec biome check`, `pnpm run x -- add`).
    const own = args.slice(
      0,
      ((index) => (index < 0 ? args.length : index))(
        args.findIndex((arg) => arg === "exec" || arg === "run" || arg === "--"),
      ),
    );
    // `pnpm exec` / `yarn exec` / `bun exec` run an already installed local binary; `npm exec`
    // fetches a missing package like npx, so it stays an install.
    const fetchingExec = name === "npm" && args.includes("exec");
    return (
      (installer.test(name ?? "") &&
        (fetchingExec ||
          own.some((arg) =>
            /^(?:i|install|ci|add|update|upgrade|sync|tool|dlx|create)$/.test(arg),
          ))) ||
      name === "uvx" ||
      name === "npx" ||
      (name === "yarn" && args.length === 0) ||
      (["uv", "pipx", "poetry", "pdm"].includes(name ?? "") &&
        args.some((arg) => arg === "run" || arg === "venv")) ||
      (/^python\d*(?:\.\d+)*$/.test(name ?? "") &&
        args.some(
          (arg, index) => arg === "-m" && /^(?:pip|ensurepip|venv)$/.test(args[index + 1] ?? ""),
        ))
    );
  });
  if (install) return "command_install_confirmation";
  if (
    request.background ||
    analysis.warnings.includes("background_command") ||
    analysis.commands.some(({ program }) =>
      ["nohup", "setsid", "disown"].includes(program.split(/[\\/]/).at(-1) ?? ""),
    )
  )
    return "command_background_confirmation";
  if (
    analysis.network &&
    !readonlyDownload(input, analysis) &&
    (!analysis.domains.length ||
      analysis.domains.some((domain) => !COMMAND_PACKAGE_DOMAINS.some((host) => host === domain)))
  )
    return "command_network_confirmation";
  return undefined;
}

/**
 * A proven read-only download (`curl` GET/HEAD) to hosts the
 * command's network list allows is judged like reading a web page, by the network rules: every
 * host must be on the list the sandbox proxy enforces for commands (allowAll alone is not enough,
 * the bound automatic runs get) and the web level must not be "never". It then needs no separate
 * network card; the run-command level and grants decide as for any read-only command. Every
 * other network use keeps its card.
 */
export function readonlyDownload(input: EvaluationInput, analysis: CommandAnalysis | undefined) {
  if (input.request.category !== "run_command" || !analysis?.network || !analysis.readonly)
    return false;
  if (analysis.incomplete || !analysis.domains.length) return false;
  if (
    analysis.commands.some(
      ({ program }) => isNetworkProgram(program) && program.split(/[\\/]/u).at(-1) !== "curl",
    )
  )
    return false;
  if (effectiveLevel(input.settings.levels.web, input.botOverrides?.web) === "never") return false;
  const allowed = commandNetwork(input).domains;
  return analysis.domains.every((domain) => allowed.includes(domain));
}

/** As above, and the web level is "always": reading those sites needs no question at all. */
export function automaticDownload(input: EvaluationInput, analysis: CommandAnalysis | undefined) {
  return (
    readonlyDownload(input, analysis) &&
    effectiveLevel(input.settings.levels.web, input.botOverrides?.web) === "always"
  );
}

export function confirmCommand(result: PolicyResult, reason: string, trace: PolicyTrace) {
  result.decision = "ask";
  result.reason = reason;
  result.canRemember = false;
  delete result.grantScope;
  result.facts.push({ kind: "warning", value: reason });
  return trace.result(result, "boundary");
}
