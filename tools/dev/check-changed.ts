// pnpm check:changed [base]: a quick check of what changed since `base` (default: where this
// branch left main), for use while developing. It is not the merge gate — run `pnpm verify` before
// merging: cross-package breakage and the end-to-end suites are only covered there.
// Fast for edge changes (UI, one capability, tools: seconds to ~1 min). A change to a core package
// such as brain re-checks everything that depends on it, so it costs about as much as `pnpm check`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import { clearCheckPass, recordCheckPass } from "./change-fingerprint.ts";
import { enterCheckSlot } from "./check-slot.ts";
import { runStages, type Step } from "./run-steps.ts";
import { clearTscCache, readTscCacheState, writeTscCacheState } from "./tsc-cache.ts";
import { affectedWorkspaceProjects, loadWorkspaceProjects } from "./tsconfig-references.ts";

await enterCheckSlot();

// Several dev-Bot tasks run this at once; at load 250 their
// own Pi Bot searches timed out. Lower priority (children inherit it) keeps the app responsive.
// verify stays at normal priority: one at a time, and routines acceptance is timing-sensitive.
try {
  setPriority(10);
} catch {
  // Safe to ignore: only scheduling changes, and some sandboxes refuse setpriority.
}
// tsc 7 is Go and takes every core by default; three tasks' checks plus one verify reached load
// 400 on 16 cores (2026-11-05). Two threads per checker (inherited by tsc-build and the semantic
// step) keeps a quick check quick without starving the others.
process.env.GOMAXPROCS ??= "2";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
// Always against main, whatever `against` this run compares with: pibot-dev recomputes the same
// fingerprint before review, and two different bases would never match. A fingerprint that cannot
// be written only costs the workflow one extra check run, never a wrong pass.
function recordPass() {
  try {
    recordCheckPass(process.cwd());
  } catch (error) {
    console.warn(`check:changed: fingerprint not written (${String(error).slice(0, 200)})`);
  }
}
// The argument names a branch or commit to compare with, and the base is where HEAD left
// it. Passing `main` used to diff against main's tip, so a worktree that had fallen behind counted
// every file main changed since (166 files for a 15-file task) and re-checked nearly every package.
const against = process.argv[2] ?? "main";
const base = git("merge-base", "HEAD", against);
// Working-tree changes count too: `git diff <base>` compares against the files on disk.
const changed = [
  ...new Set([
    ...git("diff", "--name-only", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ]),
].filter(Boolean);
if (!changed.length) {
  // A pass with nothing to check is still a pass: record it so a workflow run that finds no
  // changes does not rerun the check for an answer it already has.
  recordPass();
  console.log(`check:changed: nothing changed since ${base.slice(0, 8)}`);
  process.exit(0);
}
const touches = (prefix: string) => changed.some((file) => file.startsWith(prefix));
// tools/ has its own Biome config and step below; deleted files have nothing to lint.
const lintable = changed.filter((file) => !file.startsWith("tools/") && existsSync(file));
console.log(
  `check:changed: ${changed.length} files since ${base.slice(0, 8)} (merge-base with ${against})`,
);

const repo = process.cwd();
// The incremental data under each package's `.cache/tsc` is only trustworthy for the
// sources it was built from. Syncing main or switching branches rewrites them, and tsc's mtime
// check then answers "up to date" for files whose declarations changed, so the check would pass on
// stale declarations while verify (a fresh build) fails. Dropping the cache is only a delete; the
// build that follows compiles what this run needs either way, so the normal case pays nothing.
const head = git("rev-parse", "HEAD");
const recorded = readTscCacheState(repo);
if (recorded && (recorded.head !== head || recorded.base !== base)) {
  console.log(
    `check:changed: HEAD or merge-base moved (${recorded.head.slice(0, 8)}→${head.slice(0, 8)}, ` +
      `base ${recorded.base.slice(0, 8)}→${base.slice(0, 8)}); dropping the tsc cache`,
  );
  console.log(`check:changed: dropped the tsc cache of ${clearTscCache(repo)} packages`);
}
// Recorded before the build: a run that fails on a real error must not throw the cache away again.
writeTscCacheState(repo, { head, base });
const affected = affectedWorkspaceProjects(loadWorkspaceProjects(repo), changed, repo);
const checks: Step[] = [
  ...(affected.length
    ? [
        {
          label: "typecheck",
          command: "node",
          args: [
            "tools/dev/tsc-build.ts",
            ...affected.flatMap((project) => ["--project", project.root]),
          ],
        } satisfies Step,
        {
          label: "typecheck-extras",
          command: "node",
          args: [
            "tools/dev/typecheck-extras.ts",
            ...affected.flatMap((project) => ["--project", project.root]),
          ],
        } satisfies Step,
      ]
    : []),
  // An empty path list would make Biome check the whole repository.
  ...(lintable.length
    ? [
        {
          label: "biome",
          command: "pnpm",
          // Explicit paths, not `--changed`: Biome's --changed only sees committed changes, so the
          // uncommitted work of every Bot / Codex task was never linted (check:changed passed,
          // verify's biome failed). Biome still applies its ignore rules to explicit paths.
          args:
            lintable.length > 400
              ? ["exec", "biome", "check", "."]
              : [
                  "exec",
                  "biome",
                  "check",
                  "--no-errors-on-unmatched",
                  "--files-ignore-unknown=true",
                  ...lintable,
                ],
        } satisfies Step,
      ]
    : []),
  // Tests related to the changed files, through vitest's import graph.
  {
    label: "test",
    command: "pnpm",
    args: ["exec", "vitest", "run", "--changed", base, "--passWithNoTests"],
  },
];
// Migrations are SQL files nothing imports, so vitest --changed never selects the storage tests
// that apply them and list every table (a task once passed check:changed and failed verify).
if (touches("packages/storage/migrations/"))
  checks.push({
    label: "storage-migrations",
    command: "pnpm",
    args: ["exec", "vitest", "run", "packages/storage"],
  });
// tools/ subdirectories with a tsconfig of their own, mirroring the configs root package.json's
// `typecheck` names. Typechecking only fake-llm let 6 type errors in tools/eval reach verify,
// so a changed subdirectory picks its own project; keep this table and that script in
// sync when a tools project is added or removed.
const toolProjects = [
  { dir: "tools/codex/", config: "tools/codex/tsconfig.json" },
  { dir: "tools/pibot-dev/", config: "tools/pibot-dev/tsconfig.json" },
  { dir: "tools/eval/", config: "tools/eval/tsconfig.json" },
  { dir: "tools/ui-driver/", config: "tools/ui-driver/release/tsconfig.json" },
  { dir: "tools/fake-llm/", config: "tools/fake-llm/tsconfig.json" },
];
// tools/codex and tools/eval belong to the private development repository; a public checkout
// has neither, so a project whose tsconfig is missing is skipped rather than failing tsc.
const changedToolProjects = toolProjects.filter(
  (project) => touches(project.dir) && existsSync(project.config),
);
if (touches("tools/"))
  checks.push(
    // A tools/ change elsewhere (tools/dev, tools/probes) has no project: those scripts run through
    // node and hooks, so they keep the previous behaviour of typechecking fake-llm.
    ...(changedToolProjects.length
      ? changedToolProjects
      : toolProjects.filter((project) => project.dir === "tools/fake-llm/")
    ).map(
      (project) =>
        ({
          label: `tools-types:${project.dir.split("/")[1]}`,
          command: "pnpm",
          args: ["exec", "tsc", "--noEmit", "-p", project.config],
        }) satisfies Step,
    ),
    {
      label: "tools-lint",
      command: "pnpm",
      args: ["exec", "biome", "check", "--config-path", "tools/biome.json", "tools"],
    },
  );
if (touches("tests/e2e/") || touches("tools/fake-llm/"))
  checks.push({
    label: "e2e-types",
    command: "pnpm",
    args: ["exec", "tsc", "--noEmit", "-p", "tests/e2e/tsconfig.json"],
  });
if (touches("tests/integration/workflows/"))
  checks.push({
    label: "workflow-regression",
    command: "pnpm",
    args: ["eval", "workflows"],
  });
// `pnpm lint` runs capability-check, which compares the model-facing tool catalog with the
// CAPABILITIES / GENERAL_TOOLS registration in protocol-base. No package's typecheck or test sees
// that mismatch, so a task once shipped tools missing from the registration, passed the automatic
// re-check and failed verify — a whole round lost. Tool specs live in a `tools/` directory of a
// package's src (capability contracts, protocol-base, the brain kernel) plus `tools.ts` files and
// the aggregation layer that spreads them, so a change in any of those runs the check.
const touchesToolDefinitions = changed.some(
  (file) =>
    file.startsWith("packages/") &&
    (/\/tools\//.test(file) ||
      // `tools.ts` and `<area>-tools.ts` (e.g. runtime/media/office-tools.ts) both define specs.
      /tools\.ts$/.test(file) ||
      file.startsWith("packages/protocol/src/aggregate/")),
);
if (touchesToolDefinitions)
  checks.push({
    label: "capability-check",
    command: "node",
    args: ["tools/dev/capability-check.ts"],
  });
// Cheap repository-wide rules that a package filter cannot see. A review compared this with the
// `lint` script: the three below were the only ones missing here, and each takes under a second.
const rules: Step[] = [
  { label: "boundaries", command: "node", args: ["tools/dev/domain-boundaries.ts"] },
  { label: "agents-sync", command: "node", args: ["scripts/sync-agent-docs.mjs", "--check"] },
  { label: "i18n-keys", command: "node", args: ["tools/dev/check-i18n-keys.ts"] },
  {
    label: "tsconfig-references",
    command: "node",
    args: ["tools/dev/tsconfig-references.ts", "--check"],
  },
  {
    label: "theme-tokens",
    command: "node",
    args: ["packages/ui/scripts/generate-tokens.ts", "--check"],
  },
  // Every registered tool must declare its attributes. A tool added without them silently
  // leaves the derived lists (write deliveries, permission categories), which no typecheck sees
  // because the declaration is an ordinary object key.
  { label: "tool-attributes", command: "node", args: ["tools/dev/tool-attributes.ts"] },
];
const teamsTextChanged =
  touches("packages/teams/builtin") || touches("packages/teams/src/brain/builtin");
if (teamsTextChanged)
  rules.push({ label: "builtin", command: "node", args: ["tools/dev/builtin-pack.ts", "check"] });
// Built-in text names tools by hand; a name the catalog lacks only surfaces when a real model
// tries to call it, so the check runs wherever that text can change — and wherever the
// tool names themselves can (a rename passes capability-check but breaks this text).
if (teamsTextChanged || touchesToolDefinitions)
  rules.push({
    label: "builtin-tools",
    command: "node",
    args: ["tools/dev/builtin-tool-names.ts"],
  });

try {
  // A record left by an earlier run describes work this run is no longer checking, so it
  // is dropped before the checks start and only a passing run writes a new one.
  clearCheckPass(process.cwd());
  // One step at a time: a quick check must not compete with whatever else the machine runs (a
  // parallel first try reached load 250 beside two builds).
  await runStages([...checks.map((step) => [step]), rules]);
  recordPass();
  console.log("check:changed: passed (run pnpm verify before merging)");
} catch (error) {
  console.error(`check:changed: ${(error as Error).message}`);
  process.exit(1);
}
