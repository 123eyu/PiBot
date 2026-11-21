import { isAbsolute } from "node:path";

/** No shell expansion: this deliberately admits one exec with literal words only. */
export function gitHookEntry(script: string): { program: string; args: string[] } | undefined {
  if (!script.startsWith("#!/bin/sh\n") || script.length > 32768 || /[\0\r]/.test(script)) return;
  const body = script.slice(10).trim();
  const word = "(?:'[A-Za-z0-9_./:@%+=, \\-]+'|[A-Za-z0-9_./:@%+=,\\-]+)";
  if (!new RegExp(`^exec ${word}(?: ${word})*$`).test(body)) return;
  const words = body
    .slice(5)
    .match(/'[^']+'|[^ ]+/g)
    ?.map((value) => (value.startsWith("'") ? value.slice(1, -1) : value));
  if (!words || words.length > 5) return;
  const [program, ...args] = words;
  if (!program || !isAbsolute(program)) return;
  if (["/usr/bin/true", "/usr/bin/false"].includes(program) && args.length === 0)
    return { program, args };
  if (
    program !== "/usr/bin/plutil" ||
    args.length !== 3 ||
    args[0] !== "-lint" ||
    args[1] !== "--" ||
    !args[2]?.endsWith(".plist")
  )
    return;
  return { program, args };
}

export function selectedGitHook(program: string, args: readonly string[]) {
  if (!/^(?:git|.*[/\\]git(?:\.exe)?)$/.test(program)) return false;
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const value = args[index++];
    if (
      [
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--config-env",
        "--super-prefix",
        "--attr-source",
      ].includes(value ?? "")
    )
      index++;
    // Selection grants nothing. Unknown flags before an explicit hook must fail closed too,
    // while ordinary subcommands such as log --grep hook remain on their existing path.
  }
  return args[index] === "hook";
}

export const gitHookQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
