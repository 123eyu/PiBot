import { type ArgumentFacts, type FindAction, optionFacts } from "./argument-types.ts";
import { type OptionRule, type OptionSpec, parseOptions } from "./options/options.ts";
export const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const named: Record<string, OptionRule> = {};
for (const key of [
  "-P",
  "-H",
  "-L",
  "-depth",
  "-print",
  "-print0",
  "-ls",
  "-empty",
  "-executable",
  "-readable",
  "-writable",
  "-true",
  "-false",
  "-o",
  "-or",
  "-a",
  "-and",
  "-not",
  "-prune",
])
  named[key] = { argument: "none" };
for (const key of [
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-maxdepth",
  "-mindepth",
  "-user",
  "-group",
  "-perm",
  "-links",
  "-inum",
])
  named[key] = { argument: "value" };
for (const key of ["-newer", "-anewer", "-cnewer", "-samefile", "-files0-from"])
  named[key] = { argument: "value", path: "read" };
for (const key of ["-fprint", "-fprint0", "-fprintf", "-fls"])
  named[key] = { argument: "value", path: "write", mutates: true };
for (const key of ["-delete", ...FIND_ACTIONS]) named[key] = { argument: "none", mutates: true };
named["-L"] = { argument: "none", incomplete: true };
named["-files0-from"] = { argument: "value", path: "read", incomplete: true };
const findOptions: OptionSpec = { named };
export function findRoots(args: readonly string[]): string[] {
  let cursor = 0;
  while (["-P", "-H", "-L"].includes(args[cursor] ?? "")) cursor++;
  const roots: string[] = [];
  for (; cursor < args.length; cursor++) {
    const arg = args[cursor] ?? "";
    if (arg.startsWith("-") || ["!", "(", ")"].includes(arg)) break;
    roots.push(arg);
  }
  return roots.length ? roots : ["."];
}
export function findFacts(args: string[]): ArgumentFacts {
  const roots = findRoots(args);
  const actions: FindAction[] = [];
  const expression: string[] = [];
  let malformed = false;
  // Action argv belongs to another invocation, never to find's own option parser.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    expression.push(arg);
    if (FIND_ACTIONS.has(arg)) {
      const start = ++i;
      while (i < args.length && ![";", "+"].includes(args[i] ?? "")) i++;
      if (i === args.length) malformed = true;
      actions.push({ option: arg, words: args.slice(start, i) });
    } else if (named[arg]?.argument === "value") {
      // Keep a value such as -exec or -name literal instead of interpreting it as an action.
      if (args[i + 1] !== undefined) expression.push(args[++i] as string);
      if (arg === "-fprintf" && args[i + 1] !== undefined) i++; // format string
    }
  }
  const parsed = parseOptions(expression, findOptions);
  const result = optionFacts(parsed);
  result.reads.unshift(...roots);
  if (parsed.flags.has("-delete")) result.writes.push(...roots);
  result.incomplete ||= malformed;
  result.find = { roots, actions };
  return result;
}
