import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  createPolicy,
  type EvaluationInput,
  type Platform,
  type PolicyRequest,
} from "../../../packages/policy/src/index.ts";
import {
  CategorySchema,
  PermissionLevelsSchema,
} from "../../../packages/protocol-base/src/index.ts";
import { type ScriptCase, scriptScenarios } from "./scripts.ts";

const platforms = ["darwin", "linux", "win32"] as const;
const levels = ["never", "ask", "always"] as const;
const id = "00000000-0000-4000-8000-000000000001";
const digest = "0".repeat(64);

function inputs(platform: Platform) {
  const path = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? "C:\\matrix" : "/matrix";
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const protectedRoot = path.join(root, "protected");
  const skill = path.join(root, "skill");
  const environment = path.join(root, "environment");
  const targets = {
    inside: path.join(work, "file.txt"),
    outside: path.join(root, "outside", "file.txt"),
    protected: path.join(protectedRoot, "file.txt"),
    skill: path.join(skill, "SKILL.md"),
    environment: path.join(environment, "python"),
    aiConfig: path.join(home, ".other-agent", "settings.json"),
    unresolved: path.join(work, "inaccessible", "file.txt"),
  };
  const fs = {
    async realpath(value: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (path.basename(value) === "inaccessible")
        throw Object.assign(new Error("synthetic path access error"), { code: "EACCES" });
      return value;
    },
  };
  const command = (target: string): PolicyRequest => ({
    category: "run_command",
    command: platform === "win32" ? `Get-Content '${target}'` : `cat '${target}'`,
  });
  const scenarios = {
    read_file: { category: "read_file", path: targets.inside },
    list_dir: { category: "list_dir", path: work },
    write_file: { category: "write_file", path: targets.inside },
    run_command: command(targets.inside),
    connector: { category: "connector", operation: "discover", visible: true },
    computer: { category: "computer" },
    read_ai_config: { category: "read_ai_config" },
    read_messages: { category: "read_messages", target: id, scopeValid: true },
    send_out: {
      category: "send_out",
      identity: "user",
      connectorId: id,
      tool: "matrix_send",
      target: "matrix",
      definitionDigest: digest,
      targetDigest: digest,
      rememberable: false,
    },
    web: { category: "web", url: "https://example.com/" },
    image_generation: {
      category: "image_generation",
      recipient: "example.com",
      provider: "matrix",
      model: "matrix",
    },
    tool_discovery: { category: "tool_discovery" },
    planning: { category: "planning" },
    routine_proposal: { category: "routine_proposal", operation: "propose" },
    skill_proposal: { category: "skill_proposal" },
    check_proposal: { category: "check_proposal" },
    collaboration: { category: "collaboration", operation: "assign_task" },
    memory: { category: "memory", operation: "add" },
    memory_read: { category: "memory_read" },
    review: { category: "review" },
    phone_data: { category: "phone_data", operation: "media" },
    background: { category: "background", operation: "list" },
    browser_tabs: { category: "browser_tabs" },
  } satisfies Record<PolicyRequest["category"], PolicyRequest>;
  const extra: Record<string, PolicyRequest> = {
    "read_file/outside": { category: "read_file", path: targets.outside },
    "read_file/protected": { category: "read_file", path: targets.protected },
    "read_file/skill": { category: "read_file", path: targets.skill },
    "read_file/ai_config": { category: "read_file", path: targets.aiConfig },
    "read_file/remote_unresolved": { category: "read_file", path: targets.inside },
    "read_file/unresolved": { category: "read_file", path: targets.unresolved },
    "list_dir/outside": { category: "list_dir", path: path.dirname(targets.outside) },
    "list_dir/protected": { category: "list_dir", path: protectedRoot },
    "list_dir/skill": { category: "list_dir", path: skill },
    "write_file/outside": { category: "write_file", path: targets.outside },
    "write_file/protected": { category: "write_file", path: targets.protected },
    "run_command/outside": command(targets.outside),
    "run_command/environment": command(targets.environment),
    "connector/unavailable": { category: "connector", operation: "discover", visible: false },
    "read_messages/unavailable": { category: "read_messages", target: id, scopeValid: false },
    "memory/untrusted": { category: "memory", operation: "add", afterUntrusted: true },
    "web/private": { category: "web", url: "http://127.0.0.1/" },
    "web/unlisted": { category: "web", url: "https://example.org/" },
    "web/invalid": { category: "web", url: "not-a-url" },
  };
  const base = {
    botId: id,
    workplace: { home, folders: [{ id, name: "Matrix", path: work }], currentId: id },
    skillsRoot: skill,
    commandReadRoots: [environment],
    aiConfigReadBoundary: { roots: [path.dirname(targets.aiConfig)], globs: [] },
    sensitiveReadRoots: [protectedRoot],
    protectedWriteRoots: async () => [protectedRoot],
    commandIsolation: async () => platform !== "win32",
  } satisfies Partial<EvaluationInput>;
  const remoteBoundary = {
    boundaryVersion: 1,
    location: { target: "runner:matrix", platform },
    conflict: "none",
    roots: [{ id, role: "primary", path: work, canonicalPath: work, device: null, inode: null }],
    revision: 0,
    primaryId: id,
    primaryPath: work,
    readRoots: [work],
    writeRoots: [work],
    denyWriteRoots: [],
  } satisfies NonNullable<EvaluationInput["boundary"]>;
  return { base, home, fs, remoteBoundary, root, work, cases: { ...scenarios, ...extra } };
}

const header = [
  "case",
  ...platforms.flatMap((platform) => levels.map((level) => `${platform}/${level}`)),
];
const rows = new Map<string, string[]>();
for (const platform of platforms) {
  const { base, home, fs, remoteBoundary, root, work, cases } = inputs(platform);
  const scripts = await scriptScenarios(platform, root, work, id);
  const policy = await createPolicy({
    platform,
    userHome: home,
    fs: {
      realpath: async (value: string, signal: AbortSignal) =>
        fs.realpath(await scripts.fs.realpath(value), signal),
      readScript: scripts.fs.readScript,
      listNames: scripts.fs.listNames,
    },
  });
  const evaluate = async (
    name: string,
    level: (typeof levels)[number],
    request: PolicyRequest,
    extra: Omit<ScriptCase, "request"> & { boundary?: EvaluationInput["boundary"] } = {},
  ) => {
    // Intrinsic categories have no permission level. Vary every real setting to prove
    // intrinsic decisions (especially memory_read) do not accidentally depend on one.
    const result = await policy.evaluate({
      ...base,
      request,
      signal: AbortSignal.timeout(15_000),
      ...(name === "read_file/remote_unresolved" ? { boundary: remoteBoundary } : {}),
      ...(extra.boundary ? { boundary: extra.boundary } : {}),
      ...(extra.grants ? { grants: extra.grants } : {}),
      settings: {
        levels: PermissionLevelsSchema.parse({
          ...Object.fromEntries(CategorySchema.options.map((category) => [category, level])),
          ...extra.levels,
        }),
        network: { allowAll: false, domains: ["example.com"] },
      },
    });
    if (
      result.decision === "deny" &&
      !result.explanation.some((step) => step.effect === "deny" && step.code === result.reason)
    )
      throw new Error(`Missing refusal check: ${name}/${platform}/${level}`);
    return result;
  };
  try {
    for (const [name, request] of Object.entries(cases)) {
      const row = rows.get(name) ?? [];
      for (const level of levels) {
        const result = await evaluate(name, level, request);
        row.push(`${result.decision}:${result.reason}`);
      }
      rows.set(name, row);
    }
    for (const [name, { request, ...extra }] of Object.entries(scripts.cases)) {
      const row = rows.get(name) ?? [];
      for (const level of levels) {
        const result = await evaluate(name, level, request, extra);
        row.push(`${result.decision}:${result.reason}`);
      }
      rows.set(name, row);
    }
    const boundary = { boundary: scripts.boundary };
    for (const [name, { request, cell }] of Object.entries(scripts.routine)) {
      const row = rows.get(name) ?? [];
      for (const level of levels) {
        const result = await evaluate(name, level, request, boundary);
        row.push(`${result.decision}:${result.reason}:${cell(result)}`);
      }
      rows.set(name, row);
    }
    const row = rows.get("routine/script_changed") ?? [];
    for (const level of levels)
      row.push(await scripts.changed((request) => evaluate("routine", level, request, boundary)));
    rows.set("routine/script_changed", row);
  } finally {
    policy.dispose();
    await scripts.dispose();
  }
}

const actual = [header, ...Array.from(rows, ([name, row]) => [name, ...row])]
  .map((row) => row.join("\t"))
  .join("\n");
process.stdout.write(`${actual}\n`);
const expected = (await readFile(new URL("./expected.tsv", import.meta.url), "utf8")).trimEnd();
if (actual !== expected) {
  const wanted = expected.split("\n");
  const got = actual.split("\n");
  for (let i = 0; i < Math.max(wanted.length, got.length); i++) {
    if (wanted[i] === got[i]) continue;
    process.stderr.write(
      `Policy matrix row ${i + 1}\n  expected: ${wanted[i] ?? "(absent)"}\n  actual:   ${got[i] ?? "(absent)"}\n`,
    );
  }
  process.exitCode = 1;
}
