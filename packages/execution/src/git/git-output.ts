import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { matchesFileIdentity } from "../core/file-identity.ts";
import { missing, writablePath } from "../core/paths.ts";
import { ExecError, type FileContext, type RunCommandOptions } from "../core/types.ts";
import { publishNewBinaryFile, readBinaryFile } from "../files/binary-files.ts";
import { directoryIdentity, verifyWorkspace } from "../sandbox/workspace.ts";
import type { GitObjectObservation } from "./git-config-object-view.ts";
import { GitOutputSourceError } from "./git-output-error.ts";
import { emptyOutputTree, gitOutputIntent } from "./git-output-intent.ts";
import { inspectOutputObjects } from "./git-output-objects.ts";
import { outputScanBudget } from "./git-output-scan.ts";
import { verifyOutputSources } from "./git-output-sources.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Input = FileContext & {
  command: string;
  program: string;
  args: string[];
  path: string;
  revalidate(): void;
  platform: NodeJS.Platform;
};

/** No public constructor, transferable token, or structural JSON authority. */
class OutputPlan {
  #claimed = false;
  readonly #input: Input;
  readonly #sources: (GitObjectObservation & { hash?: string })[];
  private constructor(input: Input, sources: (GitObjectObservation & { hash?: string })[]) {
    this.#input = input;
    this.#sources = sources;
  }
  static async prepare(input: Input) {
    const context: Input = {
      ...input,
      args: [...input.args],
      writeRoots: [...input.writeRoots],
      denyWriteRoots: [...(input.denyWriteRoots ?? [])],
      rootIdentities: input.rootIdentities?.map((root) => ({ ...root })),
    };
    const intent = gitOutputIntent(input.program, input.args);
    if (
      !intent ||
      input.platform !== process.platform ||
      !["darwin", "linux"].includes(input.platform)
    )
      throw new ExecError("invalid_input");
    input.revalidate();
    await verifyWorkspace(context.rootIdentities, context.signal);
    const path = await writablePath(
      input.path,
      input.cwd,
      context.writeRoots,
      context.denyWriteRoots,
    );
    if (path !== input.expectedPath || path !== resolve(input.cwd, input.path))
      throw new ExecError("outside_workplace");
    // Capture the existing output parent before the child starts, not only at publication.
    const parent = await directoryIdentity(dirname(path));
    if (parent.canonicalPath !== dirname(path)) throw new ExecError("outside_workplace");
    await absent(path);
    context.rootIdentities?.push(parent);
    context.path = path;
    const gitDirectory = join(context.cwd, ".git");
    if ((await gitResourceIdentity(gitDirectory))?.type !== "directory")
      throw new GitOutputSourceError("object_layout");
    const gitIdentity = await directoryIdentity(gitDirectory);
    if (gitIdentity.canonicalPath !== gitDirectory) throw new GitOutputSourceError("object_layout");
    context.rootIdentities?.push(gitIdentity);
    const candidates =
      input.platform === "darwin"
        ? [
            "/Library/Developer/CommandLineTools/usr/bin/git",
            "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
          ]
        : ["/usr/bin/git", "/bin/git"];
    let program: string | undefined;
    for (const candidate of candidates) {
      if (
        input.program !== "git" &&
        input.program !== "/usr/bin/git" &&
        input.program !== candidate
      )
        continue;
      try {
        const stat = await lstat(candidate);
        if (
          stat.isFile() &&
          stat.uid === 0 &&
          !(stat.mode & 0o022) &&
          stat.mode & 0o111 &&
          (await realpath(candidate)) === candidate
        ) {
          program = candidate;
          break;
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (!program) throw new ExecError("git_unavailable");
    const source = await gitResourceIdentity(program);
    if (source?.type !== "file" || (await realpath(program)) !== program)
      throw new ExecError("git_unavailable");
    context.program = program;
    const programRead = await readGitResource(program, 16 * 1024 * 1024, context.signal);
    if (!programRead.hash || !sameGitIdentity(source, await gitResourceIdentity(program)))
      throw new ExecError("git_unavailable");
    const sources = [
      { path: program, identity: source, hash: programRead.hash },
      ...(await inspectOutputObjects(gitDirectory, intent.oids[0]?.length ?? 40, context.signal))
        .sources,
    ];
    context.revalidate();
    context.signal.throwIfAborted();
    const plan = new OutputPlan(context, sources);
    issued.add(plan);
    Object.freeze(plan);
    return plan;
  }
  async stage(input: RunCommandOptions, temp: string, signal: AbortSignal) {
    // Private field access also rejects an object forged with this class's prototype.
    if (
      this.#claimed ||
      input.command !== this.#input.command ||
      input.cwd !== this.#input.cwd ||
      input.writeRoots.length ||
      !input.assertAuthorized
    )
      throw new ExecError("invalid_input");
    this.#claimed = true;
    const context = this.#input;
    const check = async () => {
      const budget = outputScanBudget(signal);
      await budget.read(() => verifyWorkspace(context.rootIdentities, signal));
      await budget.read(() => absent(context.path));
      await verifyOutputSources(this.#sources, signal, budget);
      context.revalidate();
      input.assertAuthorized?.();
      budget.check();
    };
    await check();
    const directory = await mkdtemp(join(temp, "git-output-"));
    const identity = await directoryIdentity(directory);
    const path = join(directory, "stdout");
    const view = join(directory, "view");
    await mkdir(view);
    await mkdir(join(view, "objects"));
    await mkdir(join(view, "refs"));
    const empty = emptyOutputTree(gitOutputIntent("git", context.args)?.oids[0]?.length ?? 40);
    await mkdir(join(view, "objects", empty.slice(0, 2)), { recursive: true });
    await writeFile(
      join(view, "objects", empty.slice(0, 2), empty.slice(2)),
      deflateSync(Buffer.from("tree 0\0")),
      { mode: 0o600, signal },
    );
    await writeFile(join(view, "HEAD"), "ref: refs/heads/unused\n", {
      flag: "wx",
      mode: 0o600,
      signal,
    });
    const intent = gitOutputIntent("git", context.args);
    if (!intent) throw new ExecError("invalid_input");
    await writeFile(
      join(view, "config"),
      intent.oids[0]?.length === 64
        ? "[core]\n repositoryformatversion=1\n bare=true\n[extensions]\n objectFormat=sha256\n"
        : "[core]\n repositoryformatversion=0\n bare=true\n",
      { flag: "wx", mode: 0o600, signal },
    );
    const environment = {
      GIT_DIR: view,
      GIT_COMMON_DIR: view,
      GIT_OBJECT_DIRECTORY: join(context.cwd, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(view, "objects"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    };
    const prefix = Object.entries(environment)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ");
    const command = [context.program, ...context.args].map(quote).join(" ");
    const commitChecks = intent.oids
      .map(
        (oid) =>
          `${prefix} ${quote(context.program)} --no-pager cat-file -e ${quote(`${oid}^{commit}`)}`,
      )
      .join(" && ");
    return {
      // /bin/bash is execution's fixed POSIX shell. Its 1024-byte file limit bounds raw
      // staging output even while the process runs; log truncation is never a data source.
      command: `ulimit -f 20480 && ${commitChecks} && ${prefix} ${command} > ${quote(path)}`,
      check,
      async publish() {
        await check();
        const raw = await readBinaryFile({
          cwd: directory,
          path,
          expectedPath: path,
          rootIdentities: [identity],
          writeRoots: [],
          signal,
        });
        return publishNewBinaryFile({
          ...context,
          signal,
          bytes: raw.bytes,
          expectedPath: context.path,
          async revalidate() {
            await check();
            await context.confirmDispatch?.();
            await check();
          },
        });
      },
      async close() {
        try {
          const current = await lstat(directory, { bigint: true });
          if (!matchesFileIdentity(current, identity) || (await realpath(directory)) !== directory)
            throw new ExecError("command_failed", "cleanup_failed");
          await rm(directory, { recursive: true });
        } catch (error) {
          if (!missing(error)) throw error;
        }
      },
    };
  }
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new ExecError("file_conflict");
}
Object.freeze(OutputPlan.prototype);
const issued = new WeakSet<OutputPlan>();
export type GitOutputPlan = OutputPlan;
/** Fixed entry: neither instance/prototype replacement nor a Proxy can override dispatch. */
export function stageGitOutput(
  plan: GitOutputPlan,
  input: RunCommandOptions,
  temp: string,
  signal: AbortSignal,
) {
  if (!validGitOutputPlan(plan)) throw new ExecError("invalid_input");
  return OutputPlan.prototype.stage.call(plan, input, temp, signal);
}
/** Brain calls this only after the full original command has passed its ordinary policy gate. */
export const prepareGitOutput = (input: Input) => OutputPlan.prepare(input);
export function validGitOutputPlan(plan: unknown): plan is GitOutputPlan {
  return typeof plan === "object" && plan !== null && issued.has(plan as OutputPlan);
}
