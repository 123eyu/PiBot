import { resolve } from "node:path";

/** Deliberately smaller than a shell parser: unknown syntax can run, but cannot certify a check. */
export function literalChecks(command: string, cwd: string): string[][] | undefined {
  if (command.length > 4000 || /[\p{Cc}\p{Zl}\p{Zp}\\`$%|;<>!(){}*?^[\]]/u.test(command)) return;
  const commands: string[][] = [];
  let word = "",
    quote = "",
    words: string[] = [];
  const push = () => {
    if (word) words.push(word);
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === " ") push();
    else if (c === "&") {
      if (command[++i] !== "&") return;
      push();
      if (!words.length) return;
      commands.push(words);
      words = [];
    } else word += c;
  }
  if (quote) return;
  push();
  if (!words.length) return;
  commands.push(words);
  if (commands.length > 16) return;
  if (commands[0]?.[0] === "cd") {
    if (commands[0].length !== 2 || resolve(cwd, commands[0][1] as string) !== cwd) return;
    commands.shift();
  }
  if (!commands.length || commands.some((args) => args.some((arg) => !arg || arg.includes("="))))
    return;
  return commands;
}

const managers = new Set(["pnpm", "npm", "yarn", "bun"]);
export const commandKey = (args: readonly string[]) => JSON.stringify(args);

function scriptCall(args: string[]) {
  if (!managers.has(args[0] ?? "")) return;
  const offset = args[1] === "run" || (args[0] === "bun" && args[1] === "run") ? 2 : 1;
  if (args.length !== offset + 1 || args[offset]?.startsWith("-")) return;
  return { manager: args[0] as string, name: args[offset] as string };
}

export function verificationCommand(command: string, cwd: string) {
  const commands = literalChecks(command, cwd);
  return commands?.every((args) => {
    const script = scriptCall(args);
    return script
      ? /^(?:check|typecheck|lint|test|verify)(?::[\w-]+)?$/u.test(script.name)
      : /^(?:pytest|mypy|ruff|eslint|tsc|biome)$/u.test(args[0] ?? "") ||
          (["go", "cargo", "dotnet"].includes(args[0] ?? "") &&
            ["test", "check", "vet", "clippy"].includes(args[1] ?? ""));
  })
    ? commands
    : undefined;
}

/** Expand only transparent same-manager script chains; a script's name never proves coverage. */
export function checkCoverage(commands: string[][], scripts: Record<string, string>, cwd: string) {
  const keys = new Set(commands.map(commandKey));
  let expanded = 0;
  let overflow = false;
  const visit = (args: string[], seen: Set<string>, depth: number) => {
    if (++expanded > 128) {
      overflow = true;
      return;
    }
    const call = scriptCall(args);
    if (!call || depth > 4 || seen.has(call.name)) return;
    // pre/post hooks can mutate inputs after a check, so opaque scripts stay exact-match only.
    if (scripts[`pre${call.name}`] || scripts[`post${call.name}`]) return;
    const body = scripts[call.name];
    const children = body ? literalChecks(body, cwd) : undefined;
    if (!children?.every((child) => child[0] === call.manager)) return;
    const next = new Set([...seen, call.name]);
    for (const child of children) {
      keys.add(commandKey(child));
      const nested = scriptCall(child);
      if (nested) {
        keys.add(commandKey([nested.manager, nested.name]));
        keys.add(commandKey([nested.manager, "run", nested.name]));
      }
      visit(child, next, depth + 1);
    }
  };
  for (const args of commands) visit(args, new Set(), 0);
  return overflow ? new Set(commands.map(commandKey)) : keys;
}
