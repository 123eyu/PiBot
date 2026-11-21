// Built-in content as `.pibot` folders (owner decision 2026-10-15).
//   pnpm builtin:pack check [dir]   load every folder like brain does, fail on any issue and on
//                                   any role whose copies differ between folders (run by lint)
//   pnpm builtin:pack check --minimal [dir] checks the desktop starter set in a temporary folder.
//   pnpm builtin:pack sync [dir]    copy each role's Bot entry and skill folders from
//                                   roles/<id>.pibot into every group folder that has the role,
//                                   then record the current versions in history.json;
//                                   a skill whose content changed under a recorded
//                                   pibot-version is refused: bump the version
//   pnpm builtin:pack history       rebuild history.json from every committed version in git
//                                   plus the working tree (one-time bootstrap / repair)
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyMinimalBuiltin } from "./builtin-minimal.ts";
import { capture, fail } from "./process.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultDir = join(root, "packages/teams/builtin");
type Json = Record<string, unknown>;
const read = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

type Entry = { path: string; data: Buffer };
type Team = {
  template: {
    bots: { role?: { version: number } }[];
    groups: { template?: { version: number } }[];
  };
};
type Pack = { zh: Team; en: Team };
type Content = {
  roles: Map<string, Pack>;
  groups: Map<string, Pack>;
  professions: unknown[];
  issues: string[];
};
type Table = Record<string, Record<string, unknown[]>>;
type History = { format: 1; roles: Table; groups: Table; skills?: Table };
type SkillVersion = { version: number; value: unknown };
type Brain = {
  loadBuiltin(
    dir: string,
    dataDir?: undefined,
    cloud?: undefined,
    options?: { strictRecommendations: boolean },
  ): Promise<Content>;
  consistencyIssues(content: Content): string[];
  contentWarnings(content: Content): string[];
  roleFingerprint(pack: Pack): unknown;
  groupFingerprint(pack: Pack): unknown;
  recordVariant(table: Table, key: string, version: number, value: unknown): boolean;
  builtinSkillVersions(content: Content): Map<string, SkillVersion & { roles: string[] }>;
  roleSkillVersions(pack: Pack): Map<string, SkillVersion>;
  resolveTeam(entries: Entry[], language: "zh" | "en"): Team;
};

async function brain(): Promise<Brain> {
  // Node's type stripping cannot load workspace classes with parameter properties; the locked
  // Vite toolchain already ships jiti (same loader as the acceptance tools).
  const desktop = createRequire(join(root, "apps/desktop/package.json"));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const load = (path: string) => loader.import(join(root, path)) as Promise<object>;
  return Object.assign(
    {},
    await load("packages/teams/src/brain/builtin/load.ts"),
    await load("packages/teams/src/brain/builtin/history.ts"),
    await load("packages/teams/src/brain/teams/team-archive.ts"),
  ) as Brain;
}

function format(dir: string) {
  // Keep generated JSON in the repository's Biome style so `pnpm lint` stays clean.
  execFileSync(
    process.execPath,
    [join(root, "node_modules/@biomejs/biome/bin/biome"), "format", "--write", dir],
    {
      stdio: "ignore",
    },
  );
}

const skillFolders = (skills: unknown): string[] =>
  Array.isArray(skills)
    ? (skills as Json[]).flatMap((skill) =>
        typeof skill.folder === "string" ? [skill.folder] : [],
      )
    : [];

/** Skill folders the role already had by `version`, so anything else in it is new to the group. */
function knownFolders(history: History, ref: string, version: number): Set<string> {
  const folders = new Set<string>();
  for (const [recorded, variants] of Object.entries(history.roles[ref] ?? {}))
    if (Number(recorded) <= version)
      for (const variant of variants)
        for (const folder of Object.keys((variant as { skills?: object }).skills ?? {}))
          folders.add(folder);
  return folders;
}

function sync(dir: string) {
  const history: History = existsSync(historyPath(dir))
    ? (read(historyPath(dir)) as unknown as History)
    : { format: 1, roles: {}, groups: {} };
  const groupsDir = join(dir, "groups");
  for (const name of readdirSync(groupsDir).filter((n) => n.endsWith(".pibot"))) {
    const pack = join(groupsDir, name);
    const team = read(join(pack, "team.json"));
    team.bots = (team.bots as Json[]).map((bot) => {
      const ref = String(bot.ref);
      const source = join(dir, "roles", `${ref}.pibot`);
      if (!existsSync(source)) return bot;
      const canonical = (read(join(source, "team.json")).bots as Json[])[0] as Json;
      if (!Array.isArray(canonical.skills)) return canonical;
      // A group may carry only part of its role's skills (the study group's researcher keeps the
      // two study-facing ones), so the group's own list decides what it takes. A skill the role
      // gained after the version the group carries is still added: otherwise a new skill would
      // never reach an existing group.
      const declared = new Set(skillFolders(bot.skills));
      const carried = Number((bot.role as Json | undefined)?.version ?? 0);
      const known = knownFolders(history, ref, carried);
      const skills = (canonical.skills as Json[]).filter(
        (skill) => declared.has(String(skill.folder)) || !known.has(String(skill.folder)),
      );
      rmSync(join(pack, "skills", ref), { recursive: true, force: true });
      for (const skill of skills) {
        const folder = String(skill.folder);
        const from = join(source, "skills", ref, folder);
        if (existsSync(from)) cpSync(from, join(pack, "skills", ref, folder), { recursive: true });
      }
      return { ...canonical, skills };
    });
    write(join(pack, "team.json"), team);
  }
}

const historyPath = (dir: string) => join(dir, "history.json");
const roleVersion = (pack: Pack) => pack.zh.template.bots[0]?.role?.version ?? 0;
const templateVersion = (pack: Pack) => pack.zh.template.groups[0]?.template?.version ?? 0;

/**
 * Records each role / template as it is now; content changed under an old version is flagged.
 * Skills are stricter: a changed skill under a recorded pibot-version is refused, so
 * the version must be bumped. Returns false when something was refused.
 */
function recordCurrent(history: History, content: Content, b: Brain): boolean {
  let ok = true;
  history.skills ??= {};
  for (const [folder, skill] of b.builtinSkillVersions(content)) {
    const variants = history.skills[folder]?.[String(skill.version)];
    const text = JSON.stringify(skill.value);
    if (variants?.length && !variants.some((item) => JSON.stringify(item) === text)) {
      console.error(
        `✗ skills/${folder}: content changed but pibot-version is still ${skill.version}; bump pibot-version (and role.version of ${skill.roles.join(", ")})`,
      );
      ok = false;
    } else b.recordVariant(history.skills, folder, skill.version, skill.value);
  }
  const add = (table: Table, kind: string, id: string, version: number, value: unknown) => {
    const known = !!table[id]?.[String(version)]?.length;
    if (b.recordVariant(table, id, version, value) && known)
      console.warn(`! ${kind}/${id}: v${version} content changed without a version bump`);
  };
  for (const [id, pack] of content.roles)
    add(history.roles, "roles", id, roleVersion(pack), b.roleFingerprint(pack));
  for (const [id, pack] of content.groups)
    add(history.groups, "groups", id, templateVersion(pack), b.groupFingerprint(pack));
  return ok;
}

/**
 * Every committed state of the built-in folders (the old packages/brain/builtin location too),
 * read with today's reader so the fingerprints match what Bots made from them hold.
 */
function committedPacks(commit: string, locations: string[]) {
  const files = capture("git", ["ls-tree", "-r", "--name-only", commit, "--", ...locations]).split(
    "\n",
  );
  const packs = new Map<string, Entry[]>();
  for (const path of files) {
    const match = /^(.*\/(?:roles|groups)\/[a-z0-9-]+\.pibot)\/(.+)$/.exec(path);
    if (!match?.[1] || !match[2]) continue;
    const data = execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    const list = packs.get(match[1]) ?? [];
    list.push({ path: match[2], data });
    packs.set(match[1], list);
  }
  return packs;
}

async function rebuildHistory(dir: string, b: Brain) {
  const history: History = { format: 1, roles: {}, groups: {}, skills: {} };
  const skills = history.skills as Table;
  const locations = ["packages/brain/builtin", "packages/teams/builtin"];
  const commits = capture("git", ["log", "--reverse", "--format=%H", "--", ...locations])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits)
    for (const [folder, entries] of committedPacks(commit, locations)) {
      const role = folder.includes("/roles/");
      const id = folder.slice(folder.lastIndexOf("/") + 1, -".pibot".length);
      try {
        const pack = { zh: b.resolveTeam(entries, "zh"), en: b.resolveTeam(entries, "en") };
        if (role) {
          b.recordVariant(history.roles, id, roleVersion(pack), b.roleFingerprint(pack));
          for (const [folder, skill] of b.roleSkillVersions(pack))
            b.recordVariant(skills, folder, skill.version, skill.value);
        } else b.recordVariant(history.groups, id, templateVersion(pack), b.groupFingerprint(pack));
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : "unreadable";
        console.warn(`! ${commit.slice(0, 8)} ${folder}: ${reason}`);
      }
    }
  recordCurrent(
    history,
    await b.loadBuiltin(dir, undefined, undefined, { strictRecommendations: true }),
    b,
  );
  write(historyPath(dir), history);
}

let temporary: string | undefined;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!["check", "sync", "history"].includes(command ?? ""))
    throw new Error("usage: builtin-pack check|sync|history");
  const minimal = args.includes("--minimal");
  if (minimal && command !== "check") throw new Error("minimal_only_supports_check");
  if (args.some((arg) => arg.startsWith("--") && arg !== "--minimal"))
    throw new Error("usage: builtin-pack check [dir] [--minimal] | sync|history [dir]");
  let dir = resolve(args.find((arg) => arg !== "--minimal") ?? defaultDir);
  if (minimal) {
    temporary = mkdtempSync(join(tmpdir(), "pibot-builtin-minimal-"));
    const destination = join(temporary, "builtin");
    copyMinimalBuiltin(dir, destination);
    dir = destination;
  }
  // The repository ships only the offline starter set; the full catalog (pibot-roles) is where
  // every recommendation in professions.json must resolve, so only a full catalog is strict.
  const strictRecommendations = !minimal && dir !== defaultDir;
  const b = await brain();
  if (command === "sync") {
    sync(dir);
    const history: History = existsSync(historyPath(dir))
      ? (read(historyPath(dir)) as unknown as History)
      : { format: 1, roles: {}, groups: {} };
    const recorded = recordCurrent(
      history,
      await b.loadBuiltin(dir, undefined, undefined, { strictRecommendations }),
      b,
    );
    write(historyPath(dir), history);
    format(dir);
    if (!recorded) process.exitCode = 1;
  } else if (command === "history") {
    await rebuildHistory(dir, b);
    format(dir);
  }
  const content = await b.loadBuiltin(dir, undefined, undefined, { strictRecommendations });
  const issues = [...content.issues, ...b.consistencyIssues(content)];
  console.log(
    `${content.roles.size} roles, ${content.groups.size} groups, ${content.professions.length} professions`,
  );
  for (const warning of b.contentWarnings(content)) console.warn(`! ${warning}`);
  for (const issue of issues) console.error(`✗ ${issue}`);
  process.exitCode = issues.length || process.exitCode ? 1 : 0;
} catch (error) {
  fail(error);
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
