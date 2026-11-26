import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { runStages, type Step } from "./run-steps.ts";
import { loadWorkspaceProjects } from "./tsconfig-references.ts";

const repo = resolve(import.meta.dirname, "../..");
// tsc 7 is a Go program that uses every core; four in parallel (below) times two concurrent checks
// (a verify beside a dev Bot's check:changed) drove load past 500 on 16 cores. Give each
// parallel tsc its share; alone, four shares still use the whole machine.
// Each tsc holds 1–1.5 GB; on a small machine (CI macOS: 3 cores, 7 GB) four at once swapped and the
// job ran past its hour. Run as many as memory allows, at most four.
const width = Math.max(
  1,
  Math.min(4, availableParallelism(), Math.floor(totalmem() / (2.5 * 1024 ** 3))),
);
process.env.GOMAXPROCS ??= String(Math.max(2, Math.floor(availableParallelism() / width)));
const requested = new Set<string>();
for (let index = 2; index < process.argv.length; index++)
  if (process.argv[index] === "--project") {
    const root = process.argv[++index];
    if (!root) throw new Error("--project requires a workspace root");
    requested.add(resolve(root));
  }
const projects = loadWorkspaceProjects(repo).filter(
  (project) => requested.size === 0 || requested.has(project.root),
);

const semanticConfigs = projects.map((project) => {
  const cache = join(project.root, ".cache", "tsc");
  const config = join(cache, "tsconfig.semantic.json");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        extends: relative(cache, project.config),
        compilerOptions: {
          composite: false,
          incremental: true,
          noEmit: true,
          declaration: false,
          emitDeclarationOnly: false,
          noCheck: false,
          disableSourceOfProjectReferenceRedirect: false,
          rootDir: repo,
          tsBuildInfoFile: "./semantic.tsbuildinfo",
        },
        exclude: [],
        references: [],
      },
      null,
      2,
    )}\n`,
  );
  return relative(repo, config);
});

const semanticSteps: Step[] = semanticConfigs.map((config, index) => ({
  label: `${projects[index]?.name ?? config}:semantics`,
  command: "pnpm",
  args: ["exec", "tsc", "-b", config],
}));
const semanticStages: Step[][] = [];
for (let index = 0; index < semanticSteps.length; index += width)
  semanticStages.push(semanticSteps.slice(index, index + width));
if (semanticStages.length > 0) await runStages(semanticStages);

const steps: Step[] = projects.flatMap((project) =>
  readdirSync(project.root)
    .filter((file) => /^tsconfig\..+\.json$/.test(file))
    .sort()
    .map((file) => ({
      label: `${project.name}:${basename(file, ".json")}`,
      command: "pnpm",
      args: ["exec", "tsc", "--noEmit", "-p", relative(repo, join(project.root, file))],
    })),
);

for (const [root, file] of [
  ["packages/agent", "scripts/probe.ts"],
  ["packages/ui", "scripts/generate-tokens.ts"],
] as const) {
  const absolute = resolve(repo, root);
  if (requested.size > 0 && !requested.has(absolute)) continue;
  steps.push({
    label: `${root}:script`,
    command: "pnpm",
    args: [
      "exec",
      "tsc",
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--target",
      "ES2023",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
      "--types",
      "node",
      `${root}/${file}`,
    ],
  });
}

const stages: Step[][] = [];
for (let index = 0; index < steps.length; index += width)
  stages.push(steps.slice(index, index + width));

try {
  if (steps.length) await runStages(stages);
  console.log(
    `typecheck extras: ${semanticConfigs.length} workspace semantics and ${steps.length} extra checks passed`,
  );
} catch (error) {
  console.error(`typecheck extras: ${(error as Error).message}`);
  process.exit(1);
}
