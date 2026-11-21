import type { Platform } from "../core/types.ts";
import { type ArgumentFacts, optionFacts } from "./argument-types.ts";
import { type OptionSpec, optionValues, parseOptions } from "./options/options.ts";

// GNU -i takes only an attached suffix; BSD -i requires one (including an empty string).
const sedOptions: OptionSpec = {
  flags: "nEruszb",
  values: "efl",
  optional: "i",
  longFlags: [
    "--quiet",
    "--silent",
    "--regexp-extended",
    "--separate",
    "--unbuffered",
    "--null-data",
    "--binary",
    "--sandbox",
    "--help",
    "--version",
    "--posix",
    "--follow-symlinks",
  ],
  longValues: ["--expression", "--file", "--line-length"],
  longOptional: ["--in-place"],
  readValues: ["-f", "--file"],
  mutating: ["-i", "--in-place"],
};
// Line or slash-delimited regex addresses only: without `\` or a second `/` inside, no `w`, `r`,
// `e` or `s///w` command can hide in the script.
const address = String.raw`(?:\d+|\$|/[^/\\\n]*/)`;
const printCommand = new RegExp(String.raw`^(?:${address}(?:,${address})?)?[p=]$|^\d+q$`);

/** Flags both dialects agree on; `-i`, `-f`, `-s` and long options keep the general path. */
function printOnlyScript(args: string[]): boolean {
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-e") {
      const script = args[++i];
      if (script === undefined) return false;
      scripts.push(script);
    } else if (/^-[nEr]+$/.test(arg)) continue;
    else if (arg.startsWith("-")) return false;
    else operands.push(arg);
  }
  if (!scripts.length) {
    const script = operands.shift();
    if (script === undefined) return false;
    scripts.push(script);
  }
  return scripts.every((script) =>
    script.split(";").every((command) => printCommand.test(command.trim())),
  );
}

export function sedFacts(args: string[], platform: Platform): ArgumentFacts {
  if (printOnlyScript(args)) {
    const result = interpret(args, sedOptions);
    return { ...result, readonly: true, incomplete: false };
  }
  const gnu = interpret(args, sedOptions);
  if (platform !== "darwin") return gnu;
  const bsd = interpret(args, {
    ...sedOptions,
    values: "efli",
    optional: "",
    flags: "nErua",
    longFlags: [],
    longValues: [],
    longOptional: [],
  });
  // macOS PATH may resolve GNU sed. Union both interpretations rather than miss a write.
  // This program cannot earn grants, so an extra ambiguous fact is safer than choosing a dialect.
  return {
    ...bsd,
    reads: [...new Set([...bsd.reads, ...gnu.reads])],
    writes: [...new Set([...bsd.writes, ...gnu.writes])],
    unknownOptions: [...new Set([...bsd.unknownOptions, ...gnu.unknownOptions])],
    incomplete: true,
  };
}
function interpret(args: string[], spec: OptionSpec): ArgumentFacts {
  const parsed = parseOptions(args, spec);
  const result = optionFacts(parsed);
  result.readonly = false;
  result.incomplete = true; // sed scripts can themselves open files or run commands.
  const hasScript = ["-e", "--expression", "-f", "--file"].some((key) => parsed.values.has(key));
  const paths = parsed.operands
    .slice(hasScript ? 0 : 1)
    .filter((path) => path !== "-" && path !== "");
  const inPlace = parsed.flags.has("-i") || parsed.flags.has("--in-place");
  if (!inPlace) result.reads.unshift(...paths);
  else {
    result.writes.push(...paths);
    for (const suffix of optionValues(parsed, "-i", "--in-place")) {
      if (!suffix) continue;
      for (const path of paths)
        result.writes.push(
          suffix.includes("*") ? suffix.replaceAll("*", path) : `${path}${suffix}`,
        );
    }
  }
  return result;
}
