import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedRoot } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { assertHooksPathSource, type HooksPathConfigurationPlan } from "./git-config-hooks-path.ts";
import {
  type GitConfigurationIntent,
  gitConfigurationBranchName,
  gitConfigurationChanges,
  gitConfigurationIntent,
} from "./git-config-intent.ts";
import {
  configurationGitProgram,
  type GitConfigurationProcessOptions,
  runConfigurationGit,
} from "./git-config-process.ts";

export function configurationEntries(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExecError("invalid_input");
  }
  const rows = new Map<string, (string | null)[]>();
  for (const item of text.split("\0")) {
    if (!item) continue;
    const split = item.indexOf("\n"),
      key = split < 0 ? item : item.slice(0, split);
    if (!key) throw new ExecError("invalid_input");
    const values = rows.get(key) ?? [];
    values.push(split < 0 ? null : item.slice(split + 1));
    rows.set(key, values);
  }
  return rows;
}

function assertRecipeSource(
  intent: GitConfigurationIntent,
  before: Map<string, (string | null)[]>,
  objectFormat?: "sha1" | "sha256",
) {
  const recipe = intent.recipe;
  if (!recipe) return;
  if (recipe.kind === "branch-upstream") {
    if (
      !objectFormat ||
      (before.has("core.bare") &&
        JSON.stringify(before.get("core.bare")) !== JSON.stringify(["false"])) ||
      before.has("core.worktree") ||
      (before.has("core.repositoryformatversion") &&
        ![JSON.stringify(["0"]), JSON.stringify(["1"])].includes(
          JSON.stringify(before.get("core.repositoryformatversion")),
        )) ||
      JSON.stringify(before.get("extensions.objectformat") ?? ["sha1"]) !==
        JSON.stringify([objectFormat])
    )
      throw new ExecError("invalid_input");
    const section = `remote.${recipe.name}`;
    const keys = [...before.keys()].filter((key) => key.slice(0, key.lastIndexOf(".")) === section);
    const url = before.get(`${section}.url`);
    if (
      !intent.resolvedBranch ||
      url?.length !== 1 ||
      !url[0] ||
      !gitConfigurationIntent(
        { program: intent.program, args: ["config", `${section}.url`, url[0]] },
        intent.cwd,
      ).intent ||
      keys.some((key) => key !== `${section}.url` && key !== `${section}.fetch`)
    )
      throw new ExecError("invalid_input");
    for (const [key, values] of before) {
      const match = /^remote\.(.+)\.fetch$/.exec(key);
      if (
        match &&
        JSON.stringify(values) !== JSON.stringify([`+refs/heads/*:refs/remotes/${match[1]}/*`])
      )
        throw new ExecError("invalid_input");
      if (
        key.startsWith("extensions.") &&
        (values.length !== 1 ||
          !(
            (key === "extensions.objectformat" && ["sha1", "sha256"].includes(values[0] ?? "")) ||
            (key === "extensions.refstorage" && values[0] === "files")
          ))
      )
        throw new ExecError("invalid_input");
    }
    if (
      JSON.stringify(before.get(`${section}.fetch`)) !==
      JSON.stringify([`+refs/heads/*:refs/remotes/${recipe.name}/*`])
    )
      throw new ExecError("invalid_input");
    for (const change of gitConfigurationChanges(intent))
      if ((before.get(change.key)?.length ?? 0) > 1 || before.get(change.key)?.[0] === null)
        throw new ExecError("invalid_input");
    // Slash-containing remote names could compete with the supplied remote/branch split.
    if ([...before.keys()].some((key) => key.startsWith(`${section}/`)))
      throw new ExecError("invalid_input");
    return;
  }
  const section = `remote.${recipe.name}`;
  const keys = [...before.keys()].filter((key) => key.slice(0, key.lastIndexOf(".")) === section);
  if (recipe.kind === "remote-add") {
    if (keys.length) throw new ExecError("invalid_input");
    return;
  }
  // The recipe cannot silently choose one URL, push target, mirror or custom fetch arrangement.
  const fetch = before.get(`${section}.fetch`);
  if (
    before.get(intent.key)?.length !== 1 ||
    before.get(intent.key)?.[0] === null ||
    keys.some((key) => key !== intent.key && key !== `${section}.fetch`) ||
    (fetch &&
      JSON.stringify(fetch) !== JSON.stringify([`+refs/heads/*:refs/remotes/${recipe.name}/*`]))
  )
    throw new ExecError("invalid_input");
}

/** Returns bytes only to execution; no temporary candidate path or content enters policy facts. */
export async function editGitConfigurationCopy(
  input: {
    intent: GitConfigurationIntent;
    text: string;
    privateTempRoot: string;
    process: GitConfigurationProcessOptions;
    objectFormat?: "sha1" | "sha256";
    managedBranch?: string;
    hooksPath?: HooksPathConfigurationPlan;
  },
  signal: AbortSignal,
): Promise<Buffer> {
  const program = await configurationGitProgram(input.intent.program, input.process);
  if (!program) throw new ExecError("git_unavailable");
  const tempRoot = await checkedRoot(input.privateTempRoot);
  const directory = await mkdtemp(join(tempRoot, "pibot-git-config-"));
  const path = join(directory, "config");
  const cleanup = async () => {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new ExecError("file_failed", "cleanup_failed");
    }
  };
  try {
    await writeFile(path, input.text, { flag: "wx", mode: 0o600, signal });
    const list = () =>
      runConfigurationGit(
        program,
        ["--file", path, "--null", "--list"],
        directory,
        input.process,
        signal,
      );
    const before = configurationEntries(await list());
    if ((input.intent.key === "core.hookspath") !== !!input.hooksPath)
      throw new ExecError("invalid_input");
    if (input.hooksPath) assertHooksPathSource(input.hooksPath, input.intent, before, signal);
    assertRecipeSource(input.intent, before, input.objectFormat);
    if (input.managedBranch !== undefined) {
      const intent = input.intent,
        section = `remote.${intent.value}`;
      const urls = before.get(`${section}.url`),
        fetch = before.get(`${section}.fetch`);
      if (
        !gitConfigurationBranchName(input.managedBranch) ||
        !gitConfigurationBranchName(intent.value) ||
        intent.value === "." ||
        intent.key !== `branch.${input.managedBranch}.pushremote` ||
        intent.recipe ||
        before.has("extensions.worktreeconfig") ||
        [...before.keys()].some(
          (key) => key.startsWith("include.") || key.startsWith("includeif."),
        ) ||
        (fetch !== undefined &&
          (fetch.length !== 1 || fetch[0] !== `+refs/heads/*:refs/remotes/${intent.value}/*`)) ||
        urls?.length !== 1 ||
        !urls[0] ||
        !gitConfigurationIntent(
          { program: intent.program, args: ["config", `${section}.url`, urls[0]] },
          intent.cwd,
        ).intent ||
        [...before.keys()].some(
          (key) =>
            key.startsWith(`${section}.`) && ![`${section}.url`, `${section}.fetch`].includes(key),
        ) ||
        (before.get(intent.key)?.length ?? 0) > 1 ||
        before.get(intent.key)?.[0] === null
      )
        throw new ExecError("invalid_input");
    }
    const changes = gitConfigurationChanges(input.intent);
    for (const change of changes)
      await runConfigurationGit(
        program,
        ["--file", path, "--", change.key, change.value],
        directory,
        input.process,
        signal,
      );
    const after = configurationEntries(await list());
    for (const change of changes) {
      if (JSON.stringify(after.get(change.key)) !== JSON.stringify([change.value]))
        throw new ExecError("invalid_input");
      before.delete(change.key);
      after.delete(change.key);
    }
    const ordered = (rows: Map<string, (string | null)[]>) =>
      [...rows].sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(ordered(before)) !== JSON.stringify(ordered(after)))
      throw new ExecError("invalid_input");
    const bytes = await readFile(path, { signal });
    if (bytes.length > 65_536) throw new ExecError("invalid_input");
    signal.throwIfAborted();
    return bytes;
  } finally {
    await cleanup();
  }
}
