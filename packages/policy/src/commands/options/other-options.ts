import { networkTarget } from "../../targets/network-target.ts";
import type { ArgumentFacts } from "../argument-types.ts";
import { readonlyCurl } from "./curl-options.ts";
import type { OptionSpec, ParsedOptions } from "./options.ts";

const packageOptions: OptionSpec = {
  values: "t",
  longValues: ["--prefix", "--target"],
  writeValues: ["-t", "--prefix", "--target"],
};
// These known path semantics still belong to programs outside the readonly allowlist.
export const otherOptions: Readonly<Record<string, OptionSpec>> = {
  curl: {
    flags: "sSLIf",
    values: "oTKdH",
    longValues: [
      "--header",
      "--output",
      "--upload-file",
      "--config",
      "--cert",
      "--key",
      "--cacert",
      "--data",
      "--data-binary",
      "--data-raw",
    ],
    readValues: ["-T", "-K", "--upload-file", "--config", "--cert", "--key", "--cacert"],
    writeValues: ["-o", "--output"],
  },
  wget: {
    flags: "q",
    values: "O",
    longValues: ["--output-document"],
    writeValues: ["-O", "--output-document"],
  },
  npm: packageOptions,
  pnpm: packageOptions,
  pip: packageOptions,
  pip3: packageOptions,
  brew: packageOptions,
  python: { values: "c" },
  python3: { values: "c" },
  node: { values: "ep", longValues: ["--eval", "--print"] },
  nodejs: { values: "ep", longValues: ["--eval", "--print"] },
  perl: { values: "eE" },
  ruby: { values: "e" },
  lua: { values: "e" },
  php: { values: "r" },
  sh: { values: "c" },
  bash: { values: "c" },
  zsh: { values: "c" },
  dash: { values: "c" },
};
export function otherFacts(
  result: ArgumentFacts,
  program: string,
  args: string[],
  parsed: ParsedOptions,
): ArgumentFacts {
  // A plain GET/HEAD is a download judged by the network rules. wget stays ask-only: it
  // follows redirects by default, keeps an HSTS file in HOME, reads `.wgetrc` and has recursive
  // modes, and the stdout-only form (`-qO-`) is rare enough not to justify a second parser.
  const download = program === "curl" ? readonlyCurl(args) : undefined;
  if (download) return download;
  result.readonly = false;
  if (["curl", "wget"].includes(program)) {
    for (const key of ["-d", "--data", "--data-binary"])
      for (const value of parsed.values.get(key) ?? [])
        if (value.startsWith("@")) result.reads.push(value.slice(1));
    if (program === "wget") result.writes.push(".");
    result.network = true;
    result.domains.push(
      ...parsed.operands.map(networkTarget).filter((host): host is string => !!host),
    );
  } else if (program === "defaults" && args.includes("write"))
    result.writes.push("~/Library/Preferences");
  else if (
    program === "systemctl" &&
    args.some((arg) => ["enable", "disable", "mask", "unmask"].includes(arg))
  )
    result.writes.push("/etc/systemd/system");
  else if (
    ["npm", "pnpm", "pip", "pip3", "brew"].includes(program) &&
    args.some((arg) => ["install", "add", "update", "upgrade"].includes(arg))
  ) {
    result.writes.unshift(".");
    result.network = true;
  } else
    result.reads.push(
      ...parsed.operands.filter((value) => /^[~./]|\//.test(value) && !networkTarget(value)),
    );
  return result;
}
