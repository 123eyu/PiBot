import { gitCommandOptions, gitGlobalOptions } from "../commands/options/git-options.ts";
import { type ParsedOptions, parseOptions } from "../commands/options/options.ts";
import type { CommandAnalysis } from "./types.ts";

type Override = { key: string; value?: string };
function configKey(key: string) {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  return first < 0
    ? key.toLowerCase()
    : key.slice(0, first).toLowerCase() +
        key.slice(first, last + 1) +
        key.slice(last + 1).toLowerCase();
}
const networkCommands = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const indexCommands = new Set(["status", "add", "diff", "commit", "checkout", "switch", "restore"]);

function overrides(args: string[]) {
  // Consumption only: this does not enlarge the analyzer's allow/readonly grammar.
  const spec = {
    ...gitGlobalOptions,
    flags: "pP",
    longFlags: [
      ...(gitGlobalOptions.longFlags ?? []),
      "--bare",
      "--no-lazy-fetch",
      "--paginate",
      "--no-optional-locks",
    ],
    longValues: [
      ...(gitGlobalOptions.longValues ?? []),
      "--namespace",
      "--super-prefix",
      "--config-env",
      "--shallow-file",
    ],
  };
  const parsed = parseOptions(args, spec, { offset: 0 });
  const values: Override[] = [];
  for (let index = 0; index < parsed.nextIndex; index++) {
    const arg = args[index] ?? "";
    let entry: string | undefined;
    let environment = false;
    if (arg === "-c" || arg === "--config-env") {
      environment = arg === "--config-env";
      entry = args[++index];
    } else if (arg.startsWith("--config-env=")) {
      environment = true;
      entry = arg.slice("--config-env=".length);
    } else if (arg.startsWith("-c")) entry = arg.slice(2);
    else if (arg === "-C" || spec.longValues.includes(arg)) index++;
    if (entry === undefined) continue;
    const equal = entry.indexOf("=");
    const key = configKey(equal < 0 ? entry : entry.slice(0, equal));
    const value = !environment && equal >= 0 ? entry.slice(equal + 1) : undefined;
    // Preserve reset order even when -c and --config-env are interleaved.
    if (/^credential(?:\..+)?\.helper$/.test(key) && value === "") {
      for (let i = values.length - 1; i >= 0; i--) if (values[i]?.key === key) values.splice(i, 1);
    } else values.push({ key, value });
  }
  return { values, command: args[parsed.nextIndex] ?? "", args: args.slice(parsed.nextIndex + 1) };
}
function commandOptions(command: string, args: string[]) {
  const spec = gitCommandOptions[command] ?? {};
  return parseOptions(args, {
    ...spec,
    flags: `${spec.flags ?? ""}u`,
    longFlags: [
      ...(spec.longFlags ?? []),
      "--dry-run",
      "--no-dry-run",
      "--ext-diff",
      "--textconv",
      "--no-textconv",
      "--raw",
      "--summary",
      "--check",
      "--patch-with-stat",
      "--patch-with-raw",
    ],
  });
}
function patchOutput(command: string, options: ParsedOptions) {
  const flags = options.flags;
  const requested = ["-p", "-u", "--patch", "--patch-with-stat", "--patch-with-raw"].some((flag) =>
    flags.has(flag),
  );
  // With trustExitCode an external helper may run even when --quiet suppresses patch output.
  if (command === "diff" && (flags.has("--quiet") || flags.has("-q"))) return true;
  // Mixed enable/disable options are potential uses, never evidence that an entry cannot run.
  if ((flags.has("-s") || flags.has("--no-patch")) && !requested) return false;
  if (command === "log") return requested;
  if (command !== "diff" && command !== "show") return false;
  const summaryOnly = [
    "--name-only",
    "--name-status",
    "--stat",
    "--shortstat",
    "--numstat",
    "--raw",
    "--summary",
    "--check",
  ].some((flag) => flags.has(flag));
  return requested || !summaryOnly;
}
function diffUse(key: string, command: string, options: ParsedOptions) {
  if (!patchOutput(command, options)) return false;
  if (key === "diff.external" || /^diff\..+\.command$/.test(key))
    return (
      (!options.flags.has("--no-ext-diff") || options.flags.has("--ext-diff")) &&
      (command === "diff" || options.flags.has("--ext-diff"))
    );
  if (/^diff\..+\.textconv$/.test(key))
    return (
      (!options.flags.has("--no-textconv") || options.flags.has("--textconv")) &&
      ["diff", "show", "log"].includes(command)
    );
  return false;
}
function executableUse(key: string, command: string, options: ParsedOptions) {
  if (/^credential(?:\..+)?\.helper$/.test(key))
    return (
      (command === "credential" &&
        ["fill", "approve", "reject"].includes(options.operands[0] ?? "")) ||
      (networkCommands.has(command) && options.operands.some((arg) => /^https?:\/\//i.test(arg)))
    );
  if (key === "core.hookspath")
    return (
      (command === "hook" && options.operands[0] === "run") ||
      (command === "commit" &&
        (!options.flags.has("--dry-run") || options.flags.has("--no-dry-run")))
    );
  // No actual Git version is bound here: old Git can treat even boolean values as hook paths.
  if (key === "core.fsmonitor") return indexCommands.has(command);
  if (/^filter\..+\.(?:clean|process)$/.test(key) && command === "add")
    return (
      (!options.flags.has("--dry-run") && !options.flags.has("-n")) ||
      options.flags.has("--no-dry-run")
    );
  if (/^filter\..+\.(?:smudge|process)$/.test(key))
    return ["checkout", "switch", "restore"].includes(command);
  if (key === "core.sshcommand")
    return (
      networkCommands.has(command) &&
      options.operands.some(
        (arg) =>
          /^ssh:\/\//i.test(arg) ||
          (!/^[A-Za-z]:/.test(arg) &&
            !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg) &&
            /^(?:[^/@:\s]+@)?[^/:\s]+:.+/.test(arg)),
      )
    );
  return diffUse(key, command, options);
}

/** Proven direct argv uses only; this is not an effective-config or nested execution monitor. */
export function gitInlineExecutableUse(analysis: CommandAnalysis): boolean {
  const literal = analysis.literalCommand ?? analysis.literalOutputRedirect?.command;
  if (!literal || !/^(?:git|(?:.*\/)git)$/.test(literal.program)) return false;
  const global = overrides(literal.args);
  const options = commandOptions(global.command, global.args);
  return global.values.some(({ key }) => executableUse(key.toLowerCase(), global.command, options));
}
