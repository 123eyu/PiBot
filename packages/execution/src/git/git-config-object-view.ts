import { mkdir, mkdtemp, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedRoot } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import {
  configurationGitProgram,
  type GitConfigurationProcessOptions,
  runConfigurationObjectType,
} from "./git-config-process.ts";
import { gitResourceIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export interface GitObjectObservation {
  path: string;
  identity?: GitResourceIdentity;
}

/** No alternates, alias directories or external pack/loose files may enter the private view. */
export async function inspectGitObjectView(
  gitDir: string,
  oids: readonly string[],
  signal: AbortSignal,
) {
  const observations: GitObjectObservation[] = [];
  const observe = async (path: string, type: "file" | "directory") => {
    signal.throwIfAborted();
    const identity = await gitResourceIdentity(path);
    if (
      identity &&
      (identity.type !== type ||
        (type === "file" && identity.links !== "1") ||
        (await realpath(path)) !== path)
    )
      throw new ExecError("invalid_input");
    observations.push({ path, identity });
    return identity;
  };
  const objects = join(gitDir, "objects");
  if (!(await observe(objects, "directory"))) throw new ExecError("invalid_input");
  for (const name of ["info", "pack", ...new Set(oids.map((oid) => oid.slice(0, 2)))]) {
    const path = join(objects, name);
    if (!(await observe(path, "directory"))) continue;
    if (name === "pack" || name === "info") {
      // Git opens pack/index/bitmap/MIDX by these names, not merely the two referenced loose OIDs.
      const entries: string[] = [];
      for await (const entry of await opendir(path)) {
        signal.throwIfAborted();
        if (entries.length >= 256) throw new ExecError("invalid_input");
        entries.push(entry.name);
      }
      for (const entry of entries.sort()) {
        if (
          !(name === "info"
            ? /^(?:packs|commit-graph)$/.test(entry)
            : /^(?:pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev|bitmap|mtimes|keep)|multi-pack-index)$/.test(
                entry,
              ))
        )
          throw new ExecError("invalid_input");
        await observe(join(path, entry), "file");
      }
    }
  }
  for (const oid of oids) await observe(join(objects, oid.slice(0, 2), oid.slice(2)), "file");
  return observations;
}

/** Only fixed type lookups: private config/refs prevent project/global helpers or lazy-fetch remotes. */
export async function validateGitUpstreamObjects(
  input: {
    gitDir: string;
    oids: readonly string[];
    program: string;
    privateTempRoot: string;
    process: GitConfigurationProcessOptions;
    assertSources(): void;
  },
  signal: AbortSignal,
) {
  const program = await configurationGitProgram(input.program, input.process);
  if (!program) throw new ExecError("git_unavailable");
  if (
    !input.oids.length ||
    input.oids.length > 2 ||
    input.oids.some(
      (oid) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid) || oid.length !== input.oids[0]?.length,
    )
  )
    throw new ExecError("invalid_input");
  const root = await checkedRoot(input.privateTempRoot);
  const directory = await mkdtemp(join(root, "pibot-git-object-view-"));
  const cleanup = async () => {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new ExecError("file_failed", "cleanup_failed");
    }
  };
  try {
    await mkdir(join(directory, "refs"));
    await mkdir(join(directory, "objects"));
    await writeFile(join(directory, "HEAD"), "ref: refs/heads/unused\n", {
      mode: 0o600,
      flag: "wx",
      signal,
    });
    await writeFile(
      join(directory, "config"),
      input.oids[0]?.length === 64
        ? "[core]\n repositoryformatversion = 1\n bare = true\n[extensions]\n objectFormat = sha256\n"
        : "[core]\n repositoryformatversion = 0\n bare = true\n",
      { mode: 0o600, flag: "wx", signal },
    );
    for (const oid of input.oids) {
      input.assertSources();
      await runConfigurationObjectType(
        program,
        oid,
        join(input.gitDir, "objects"),
        directory,
        input.process,
        signal,
      );
    }
  } finally {
    await cleanup();
  }
}
