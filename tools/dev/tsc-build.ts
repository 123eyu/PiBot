import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { loadWorkspaceProjects } from "./tsconfig-references.ts";

const repo = resolve(import.meta.dirname, "../..");
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
const args = ["exec", "tsc", "-b"];
if (requested.size > 0) args.push(...projects.map((project) => relative(repo, project.config)));

// pnpm resolves to a .cmd shim on Windows; a shell finds it (the arguments are fixed paths).
const result = spawnSync("pnpm", args, {
  cwd: repo,
  encoding: "utf8",
  shell: process.platform === "win32",
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}`;
const allowed = new Set([
  "packages/brain/src/integrations/search/search-run.ts:2883",
  "packages/brain/src/integrations/search/search-service.ts:2883",
  "packages/brain/src/runtime/review/code-navigation.ts:4053",
  "apps/desktop/src/renderer/features/chat/screen/chat-screen-model.ts:2883",
  "apps/desktop/src/renderer/features/chat/screen/use-chat-workspace.tsx:2883",
  "apps/mobile/src/theme/scale.ts:2883",
]);
const diagnostics = output
  .split("\n")
  .map((line) => /^(.*?)\(\d+,\d+\): error TS(\d+):/.exec(line))
  .filter((match): match is RegExpExecArray => !!match)
  .map(
    (match) =>
      `${relative(repo, resolve(repo, match[1] ?? ""))
        .split(sep)
        .join("/")}:${match[2]}`,
  );
const unexpected = diagnostics.filter((diagnostic) => !allowed.has(diagnostic));

if (result.status !== 0 && (diagnostics.length === 0 || unexpected.length > 0)) {
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}
if (diagnostics.length > 0)
  console.log(
    `tsc build: ${diagnostics.length} known declaration portability diagnostics retained; semantic build follows`,
  );
else console.log(`tsc build: ${projects.length} project references passed`);
