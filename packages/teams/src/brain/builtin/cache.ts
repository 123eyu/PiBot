import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawEntry } from "@pibot/brain/kit";
import { SkillDocumentSchema, TeamTemplateSchema } from "@pibot/protocol";
import { z } from "zod";
import type { ResolvedTeam } from "../teams/team-archive.ts";

const file = z.object({
  path: z.string(),
  data: z.string(),
  text: z.boolean(),
  script: z.boolean(),
});
const resolved = z.object({
  template: TeamTemplateSchema,
  skipped: z.number().int().nonnegative(),
  skills: z.array(
    z.array(
      z.object({
        folder: z.string(),
        enabled: z.boolean(),
        document: SkillDocumentSchema,
        files: z.array(file),
      }),
    ),
  ),
});
const schema = z.object({
  version: z.literal(1),
  bundle: z.string(),
  entries: z
    .array(z.object({ hash: z.string(), language: z.enum(["zh", "en"]), result: resolved }))
    .max(800),
});
type Entry = z.output<typeof schema>["entries"][number];
const wire = (value: ResolvedTeam): Entry["result"] => ({
  ...value,
  skills: value.skills.map((list) =>
    list.map((pkg) => ({
      ...pkg,
      files: pkg.files.map((f) => ({ ...f, data: f.data.toString("base64") })),
    })),
  ),
});
const hydrate = (value: Entry["result"]): ResolvedTeam => ({
  ...value,
  skills: value.skills.map((list) =>
    list.map((pkg) => ({
      ...pkg,
      files: pkg.files.map((f) => ({ ...f, data: Buffer.from(f.data, "base64") })),
    })),
  ),
});

/** Cache only packaged builds: source edits have no immutable bundle identity. */
export async function builtinCache(dir: string, dataDir?: string) {
  if (!dataDir) return undefined;
  let bundle: string;
  try {
    bundle = (await readFile(join(dir, "..", "main", "startup-bundle.sha256"), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(bundle)) return undefined;
  } catch {
    return undefined; /* Development and older bundles use the authoritative reader. */
  }
  const path = join(dataDir, "cache", "builtin-resolved-v1.json");
  const entries = new Map<string, Entry>();
  try {
    if ((await stat(path)).size <= 16 * 1024 * 1024) {
      const cached = schema.parse(JSON.parse(await readFile(path, "utf8")));
      if (cached.bundle === bundle)
        for (const entry of cached.entries) entries.set(`${entry.hash}:${entry.language}`, entry);
    }
  } catch {
    /* Missing/corrupt caches never prevent loading shipped resources. */
  }
  let changed = false;
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    hash(raw: RawEntry[]) {
      const hash = createHash("sha256");
      for (const entry of raw)
        hash.update(JSON.stringify([entry.path, entry.data.length])).update(entry.data);
      return hash.digest("hex");
    },
    get(hash: string, language: "zh" | "en") {
      const entry = entries.get(`${hash}:${language}`);
      if (entry) stats.hits++;
      else stats.misses++;
      return entry ? hydrate(entry.result) : undefined;
    },
    put(hash: string, language: "zh" | "en", result: ResolvedTeam) {
      entries.set(`${hash}:${language}`, { hash, language, result: wire(result) });
      changed = true;
    },
    async save() {
      if (!changed) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(dataDir, "cache"), { recursive: true, mode: 0o700 });
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, bundle, entries: [...entries.values()] }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, path);
      } catch {
        /* Optional acceleration; the parsed in-memory catalog remains authoritative. */
      } finally {
        await rm(temporary, { force: true }).catch(() => {
          /* A failed cache cleanup is harmless. */
        });
      }
    },
  };
}
