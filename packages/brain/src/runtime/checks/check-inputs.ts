import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionTarget } from "@pibot/execution";
import { fileIdentityKey, sameFile } from "@pibot/execution";
import { z } from "zod";
import { abortable } from "../../core/abort.ts";

const ignored = new Set([".git", ".pibot", ".codex", ".pnpm-store", ".cache", "coverage"]);
const manifest = z.object({ scripts: z.record(z.string(), z.string().max(4000)).optional() });
export interface CheckInputs {
  source: string;
  dependencies: string;
  scripts: Record<string, string>;
}

/** Metadata only except the bounded project script manifest; nothing is sent to the model. */
export async function checkInputs(
  target: Pick<ExecutionTarget, "readCheckpoint">,
  roots: readonly string[],
  signal: AbortSignal,
): Promise<CheckInputs | undefined> {
  const deadline = performance.now() + 2000;
  const current = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const rows: string[] = [],
    deps: string[] = [];
  let entries = 0;
  try {
    const metadata = async (path: string) => {
      current.throwIfAborted();
      if (++entries > 30_000 || performance.now() > deadline) throw new Error("check_scan_limit");
      // Exact identity: number stats round NTFS file IDs, so two entries could share a key.
      const s = await abortable(lstat(path, { bigint: true }), current);
      if (s.isSymbolicLink()) throw new Error("check_scan_link");
      return {
        s,
        key: JSON.stringify([
          path,
          fileIdentityKey(s),
          String(s.mode),
          String(s.size),
          String(s.mtimeNs),
          String(s.ctimeNs),
        ]),
      };
    };
    for (const root of [...new Set(roots)].sort()) {
      const identity = await metadata(root);
      if (!identity.s.isDirectory() || (await abortable(realpath(root), current)) !== root) return;
      rows.push(JSON.stringify([root, fileIdentityKey(identity.s)]));
      const queue = [{ path: root, rel: "" }];
      for (let i = 0; i < queue.length; i++) {
        const dir = queue[i] as { path: string; rel: string };
        for (const item of await abortable(readdir(dir.path, { withFileTypes: true }), current)) {
          if (ignored.has(item.name)) continue;
          const path = join(dir.path, item.name),
            rel = dir.rel ? `${dir.rel}/${item.name}` : item.name;
          const info = await metadata(path);
          if (
            info.s.isFile() &&
            info.s.nlink === 1n &&
            /^docs\/progress-notes\/[^/]+\.md$/u.test(rel)
          )
            continue;
          if (item.name === "node_modules" && info.s.isDirectory()) {
            deps.push(info.key);
            for (const file of [".modules.yaml", ".package-lock.json"]) {
              try {
                deps.push((await metadata(join(path, file))).key);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              }
            }
          } else if (info.s.isDirectory()) queue.push({ path, rel });
          else if (info.s.isFile()) rows.push(info.key);
          else return;
        }
      }
      const after = await metadata(root);
      if (!sameFile(after.s, identity.s)) return;
    }
    const digest = (values: string[]) =>
      createHash("sha256").update(values.sort().join("\n")).digest("hex");
    let scripts: Record<string, string> = {};
    const path = join(roots[0] as string, "package.json");
    try {
      const info = await abortable(lstat(path), current);
      if (info.size <= 128 * 1024) {
        const file = await target.readCheckpoint(path, current);
        const value = manifest.safeParse(JSON.parse(file.bytes.toString("utf8")));
        if (value.success) scripts = value.data.scripts ?? {};
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    current.throwIfAborted();
    return { source: digest(rows), dependencies: digest(deps), scripts };
  } catch {
    // An incomplete observation never certifies success; the original check will run instead.
    return undefined;
  }
}
