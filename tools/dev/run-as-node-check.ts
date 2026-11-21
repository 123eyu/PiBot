// Option a (maintainers 2026-11-14): no code path may run Pi Bot's own executable as Node.
// Child Node workloads use the helper resolved by @pibot/execution childNodeRuntime(); the
// package step turns the RunAsNode fuse off. This check fails lint and packaging if any source
// still sets ELECTRON_RUN_AS_NODE (clearing it, `delete` / `unset`, stays allowed).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const roots = ["apps", "packages", "tools"];
const skip = /(^|\/)(node_modules|out|dist|\.cache|coverage)(\/|$)/;
const setting = /ELECTRON_RUN_AS_NODE["']?\s*(?:[:=]|\]\s*=)/;
const clearing = /\b(?:delete\s+[\w.]+\.ELECTRON_RUN_AS_NODE|unset\s+ELECTRON_RUN_AS_NODE)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const rel = relative(repo, path);
    if (skip.test(rel)) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(?:[cm]?[jt]sx?|ya?ml|sh)$/.test(name) ? [path] : [];
  });
}

export function runAsNodeProblems(): string[] {
  const problems: string[] = [];
  for (const root of roots)
    for (const file of files(join(repo, root))) {
      if (file === join(repo, "tools/dev/run-as-node-check.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (setting.test(line) && !clearing.test(line) && !/^\s*(\/\/|\*|#)/.test(line))
            problems.push(`${relative(repo, file)}:${index + 1}: sets ELECTRON_RUN_AS_NODE`);
        });
    }
  const fuses = readFileSync(join(repo, "apps/desktop/scripts/package/package-fuses.ts"), "utf8");
  if (!/\[FuseV1Options\.RunAsNode\]:\s*false/.test(fuses))
    problems.push("apps/desktop/scripts/package/package-fuses.ts: RunAsNode fuse must be false");
  return problems;
}

if (import.meta.main) {
  const problems = runAsNodeProblems();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}
