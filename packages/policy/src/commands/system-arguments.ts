import type { Platform } from "../core/types.ts";
import { type ArgumentFacts, optionFacts } from "./argument-types.ts";
import { DATE_OPTIONS, type OptionSpec, parseOptions } from "./options/options.ts";

/** OS utilities have different option meanings; never accept a clock-setting operand as a read. */
export function systemArguments(
  program: string,
  args: string[],
  platform: Platform,
): ArgumentFacts | undefined {
  // Interpreters are not read-only programs: accept only the standalone version invocation.
  if (
    ["python", "python3", "node", "nodejs"].includes(program) &&
    args.length === 1 &&
    (args[0] === "--version" ||
      (args[0] === "-V" && program.startsWith("python")) ||
      (args[0] === "-v" && program.startsWith("node")))
  )
    return optionFacts(parseOptions([], {}));
  const specs: Record<string, OptionSpec> = {
    uname: {
      flags: "amnprsvio",
      longFlags: [
        "--all",
        "--kernel-name",
        "--nodename",
        "--kernel-release",
        "--kernel-version",
        "--machine",
        "--processor",
        "--hardware-platform",
        "--operating-system",
        "--help",
        "--version",
      ],
    },
    whoami: { longFlags: ["--help", "--version"] },
    cal: { flags: "13jmy", values: "AB", longFlags: ["--help", "--version"] },
    sw_vers: {
      named: {
        "-productName": { argument: "none" },
        "-productVersion": { argument: "none" },
        "-buildVersion": { argument: "none" },
      },
    },
  };
  if (program !== "date" && !Object.hasOwn(specs, program)) return;
  if (platform === "win32" || (program === "sw_vers" && platform !== "darwin"))
    return { ...optionFacts(parseOptions([], {})), readonly: false, incomplete: true };
  const spec =
    program === "date"
      ? platform === "darwin"
        ? { flags: "jnuR", values: "rvft" }
        : DATE_OPTIONS
      : (specs[program] ?? {});
  const parsed = parseOptions(args, spec);
  const result = optionFacts(parsed);
  if (program === "date") {
    if (platform === "darwin") {
      if ((parsed.values.get("-v") ?? []).some((value) => !/^[+-]?\d+[ymwdHMS]$/.test(value)))
        result.readonly = false;
      if (parsed.operands.some((value) => !value.startsWith("+")) && !parsed.flags.has("-j"))
        result.readonly = false;
      // BSD -r is epoch seconds, GNU -r is a file. Neither permits hidden path access.
      if ((parsed.values.get("-r") ?? []).some((value) => !/^-?\d+$/.test(value)))
        result.readonly = false;
    } else if (parsed.operands.some((value) => !value.startsWith("+"))) result.readonly = false;
  } else if (program === "cal") {
    if (parsed.operands.length > 3 || parsed.operands.some((value) => !/^\d{1,4}$/.test(value)))
      result.readonly = false;
  } else if (parsed.operands.length) result.readonly = false;
  return result;
}
