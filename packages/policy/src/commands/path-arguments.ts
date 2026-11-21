import { posix } from "node:path";
import { type ArgumentFacts, optionFacts } from "./argument-types.ts";
import { mutatingOptions } from "./options/mutating-options.ts";
import { optionTable, optionValues, type ParsedOptions, parseOptions } from "./options/options.ts";

/** Each mutator is parsed once; positional semantics enrich the option parser's facts. */
export function pathArguments(program: string, args: string[]): ArgumentFacts | undefined {
  const spec = Object.hasOwn(mutatingOptions, program) ? mutatingOptions[program] : undefined;
  if (!spec) return;
  const tokens = program === "tar" ? tarTokens(args, spec) : args;
  const parsed = parseOptions(tokens, spec);
  const result = optionFacts(parsed);
  result.readonly = false;
  if (["cp", "mv", "install"].includes(program)) copyFacts(result, parsed, program);
  else if (program === "tar") tarFacts(result, parsed);
  else if (program === "rsync") rsyncFacts(result, parsed);
  else if (["chmod", "chown", "chgrp"].includes(program))
    result.writes.push(...parsed.operands.slice(parsed.values.has("--reference") ? 0 : 1));
  else if (program !== "dd") result.writes.push(...parsed.operands);
  return result;
}
// Traditional tar cfv consumes f's argument from the next argv, not the remaining "v".
function tarTokens(args: string[], spec: import("./options/options.ts").OptionSpec): string[] {
  if (!args[0] || !/^[A-Za-z]+$/.test(args[0])) return args;
  const table = optionTable(spec);
  const tokens: string[] = [];
  let next = 1;
  for (const char of args[0]) {
    const key = `-${char}`;
    tokens.push(key);
    if (table.get(key)?.argument === "value" && args[next] !== undefined)
      tokens.push(args[next++] as string);
  }
  tokens.push(...args.slice(next));
  return tokens;
}
function copyFacts(result: ArgumentFacts, parsed: ParsedOptions, program: string) {
  const directories = optionValues(parsed, "-t", "--target-directory");
  // Preserve the semantic order (sources first, destination last) for approval facts.
  result.writes = [];
  if (program === "install" && (parsed.flags.has("-d") || parsed.flags.has("--directory"))) {
    result.writes.push(...directories, ...parsed.operands);
    if (directories.length) result.incomplete = true;
    return;
  }
  const sources = directories.length ? parsed.operands : parsed.operands.slice(0, -1);
  result.reads.push(...sources);
  if (program === "mv") result.writes.push(...sources);
  result.writes.push(...(directories.length ? directories : parsed.operands.slice(-1)));
  if (directories.length > 1 || !parsed.operands.length) result.incomplete = true;
}
function tarFacts(result: ArgumentFacts, parsed: ParsedOptions) {
  const directory = optionValues(parsed, "-C", "--directory").at(-1) ?? ".";
  const archives = optionValues(parsed, "-f", "--file").filter((path) => path !== "-");
  const extracting = ["-x", "--extract", "--get"].some((key) => parsed.flags.has(key));
  const creating = ["-c", "-r", "-u", "--create", "--append", "--update"].some((key) =>
    parsed.flags.has(key),
  );
  if (creating) {
    result.writes.push(...archives);
    result.reads.push(
      ...parsed.operands.map((path) =>
        posix.isAbsolute(path) || path.startsWith("~") ? path : `${directory}/${path}`,
      ),
    );
  } else result.reads.push(...archives);
  if (extracting) result.writes.push(directory);
  if (!creating && !extracting && !parsed.flags.has("-t") && !parsed.flags.has("--list"))
    result.incomplete = true;
  if (
    optionValues(parsed, "-C", "--directory").length > 1 ||
    optionValues(parsed, "-T", "--files-from").length
  )
    result.incomplete = true;
}
function rsyncFacts(result: ArgumentFacts, parsed: ParsedOptions) {
  const optionWrites = result.writes;
  result.writes = [];
  const transfer = (path: string, write: boolean) => {
    const host =
      /^(?:[^@\s/]+@)?([\w.-]+):/.exec(path)?.[1] ?? /^rsync:\/\/([^/:]+)/.exec(path)?.[1];
    if (host) {
      result.network = true;
      result.domains.push(host.toLowerCase());
    } else (write ? result.writes : result.reads).push(path);
  };
  for (const path of parsed.operands.slice(0, -1)) transfer(path, false);
  if (!parsed.flags.has("-n") && !parsed.flags.has("--dry-run"))
    for (const path of parsed.operands.slice(-1)) transfer(path, true);
  result.writes.push(...optionWrites);
  if (parsed.operands.length < 2 || parsed.values.has("-e")) result.incomplete = true;
}
