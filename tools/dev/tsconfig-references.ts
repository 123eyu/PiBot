import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface WorkspaceProject {
  name: string;
  root: string;
  config: string;
  dependencies: string[];
}

const buildOptions = {
  composite: true,
  noEmit: false,
  declaration: true,
  declarationMap: false,
  emitDeclarationOnly: true,
  disableSourceOfProjectReferenceRedirect: true,
  noCheck: true,
  outDir: ".cache/tsc",
  tsBuildInfoFile: ".cache/tsc/tsconfig.tsbuildinfo",
} as const;

function stripJsonComments(source: string): string {
  let result = "";
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (char === "\n") result += char;
      continue;
    }
    if (string) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      result += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index++;
    } else result += char;
  }
  return result;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as Record<string, unknown>;
}

function workspacePatterns(repo: string): string[] {
  return readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .map((line) => /^\s*-\s+['"]?([^'"#]+?)['"]?\s*$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => !!value);
}

function expandPattern(repo: string, pattern: string): string[] {
  let candidates = [repo];
  for (const segment of pattern.split("/")) {
    const next: string[] = [];
    for (const parent of candidates) {
      if (segment === "*") {
        if (!existsSync(parent)) continue;
        for (const entry of readdirSync(parent)) {
          const path = join(parent, entry);
          if (statSync(path).isDirectory()) next.push(path);
        }
      } else {
        const path = join(parent, segment);
        if (existsSync(path) && statSync(path).isDirectory()) next.push(path);
      }
    }
    candidates = next;
  }
  return candidates;
}

function configPath(from: string, to: string): string {
  const path = relative(from, to).split(sep).join(posix.sep);
  return path.startsWith(".") ? path : `./${path}`;
}

export function loadWorkspaceProjects(
  repo = resolve(dirname(new URL(import.meta.url).pathname), "../.."),
) {
  const manifests = workspacePatterns(repo)
    .flatMap((pattern) => expandPattern(repo, pattern))
    .filter((root) => existsSync(join(root, "package.json")));
  const raw = manifests.map((root) => {
    const manifest = readJson(join(root, "package.json"));
    if (typeof manifest.name !== "string") throw new Error(`${root}/package.json: missing name`);
    if (!existsSync(join(root, "tsconfig.json")))
      throw new Error(`${relative(repo, root)}: workspace package has no tsconfig.json`);
    return { root, manifest, name: manifest.name };
  });
  const roots = new Map(raw.map((project) => [project.name, project.root]));
  return raw
    .map(({ root, manifest, name }): WorkspaceProject => {
      const fields = ["dependencies", "devDependencies", "peerDependencies"] as const;
      const dependencies = fields
        .flatMap((field) =>
          Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
        )
        .filter(
          (dependency, index, all) => roots.has(dependency) && all.indexOf(dependency) === index,
        )
        .sort();
      return { name, root, config: join(root, "tsconfig.json"), dependencies };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function expectedReferences(project: WorkspaceProject, byName: Map<string, WorkspaceProject>) {
  return project.dependencies.map((name) => {
    const dependency = byName.get(name);
    if (!dependency) throw new Error(`${project.name}: missing workspace dependency ${name}`);
    return { path: configPath(project.root, dependency.root) };
  });
}

function comparableConfig(config: Record<string, unknown>) {
  const compilerOptions = (config.compilerOptions as Record<string, unknown> | undefined) ?? {};
  return {
    compilerOptions: Object.fromEntries(
      Object.keys(buildOptions).map((key) => [key, compilerOptions[key]]),
    ),
    exclude: config.exclude ?? [],
    references: config.references ?? [],
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateConfig(
  path: string,
  references: Array<{ path: string }>,
  options: { outDir?: string; tsBuildInfoFile?: string } = {},
) {
  const config = readJson(path);
  config.compilerOptions = {
    ...((config.compilerOptions as Record<string, unknown> | undefined) ?? {}),
    ...buildOptions,
    ...options,
  };
  const exclude = new Set(
    ((config.exclude as string[] | undefined) ?? []).filter(
      (pattern) => !["**/*.test.ts", "**/*.test.tsx", "test/**"].includes(pattern),
    ),
  );
  exclude.add("**/*.test.ts");
  exclude.add("**/*.test.tsx");
  exclude.add("test/**");
  config.exclude = [...exclude];
  config.references = references;
  return config;
}

export function affectedWorkspaceProjects(
  projects: WorkspaceProject[],
  changedFiles: readonly string[],
  repo = resolve(dirname(new URL(import.meta.url).pathname), "../.."),
) {
  const globalFiles = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "tools/dev/tsconfig-references.ts",
  ]);
  if (changedFiles.some((file) => globalFiles.has(file))) return projects;

  const byName = new Map(projects.map((project) => [project.name, project]));
  const reverse = new Map(projects.map((project) => [project.name, [] as string[]]));
  for (const project of projects)
    for (const dependency of project.dependencies) reverse.get(dependency)?.push(project.name);

  const selected = new Set<string>();
  for (const file of changedFiles) {
    const absolute = resolve(repo, file);
    const owner = projects
      .filter(
        (project) => absolute === project.root || absolute.startsWith(`${project.root}${sep}`),
      )
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (owner) selected.add(owner.name);
  }
  const queue = [...selected];
  for (const name of queue)
    for (const dependent of reverse.get(name) ?? [])
      if (!selected.has(dependent)) {
        selected.add(dependent);
        queue.push(dependent);
      }
  return [...selected]
    .map((name) => byName.get(name))
    .filter((project): project is WorkspaceProject => !!project)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function run(mode: "check" | "write") {
  const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const projects = loadWorkspaceProjects(repo);
  const byName = new Map(projects.map((project) => [project.name, project]));
  const expected = projects.map((project) => ({
    path: project.config,
    config: updateConfig(project.config, expectedReferences(project, byName)),
  }));
  expected.push({
    path: join(repo, "tsconfig.json"),
    config: updateConfig(
      join(repo, "tsconfig.json"),
      projects.map((project) => ({ path: configPath(repo, project.root) })),
      { outDir: ".cache/tsc/root", tsBuildInfoFile: ".cache/tsc/root.tsbuildinfo" },
    ),
  });

  if (mode === "write") {
    for (const item of expected)
      writeFileSync(item.path, `${JSON.stringify(item.config, null, 2)}\n`);
    execFileSync(
      "pnpm",
      ["exec", "biome", "format", "--write", ...expected.map((item) => relative(repo, item.path))],
      { cwd: repo, stdio: "inherit" },
    );
    console.log(`tsconfig references: wrote ${expected.length} configs`);
    return;
  }

  const stale = expected.filter(
    (item) => !same(comparableConfig(readJson(item.path)), comparableConfig(item.config)),
  );
  if (stale.length) {
    console.error(
      `tsconfig references are stale:\n${stale
        .map((item) => `  ${relative(repo, item.path)}`)
        .join("\n")}\nRun: node tools/dev/tsconfig-references.ts --write`,
    );
    process.exit(1);
  }
  console.log(`tsconfig references: ${projects.length} workspace projects match package.json`);
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) run(process.argv.includes("--write") ? "write" : "check");
