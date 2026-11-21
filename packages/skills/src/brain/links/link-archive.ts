import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  importedDocument,
  packagePath,
  parseSkillFile,
  readScannedFile,
  type SkillSourceFile,
  zipEntries,
} from "@pibot/brain/kit";
import {
  envExampleFilter,
  SKILL_BODY_MAX_BYTES,
  type SkillLinkListing,
} from "@pibot/skills-contract/full";
import { z } from "zod";
import { linkError, linkSubpath, parseLink } from "./link-source.ts";

export interface LinkCandidate {
  id: string;
  path: string;
  subpath: string;
  name: string;
  description: string;
  bytes: number;
  fileCount: number;
  runtimes: ("python" | "node" | "bash" | "powershell")[];
}
function localPath(value: string) {
  const path = value.replace(/^\.\//, "").replace(/\/$/, "");
  return path === "" || path === "." ? "" : linkSubpath(path);
}
/** Shared with update checks: a change of interpreters is what makes a prepared environment useless. */
export function runtimeTag(path: string): LinkCandidate["runtimes"][number] | undefined {
  if (/\.(?:py|pyw)$|(?:^|\/)requirements[^/]*\.txt$|(?:^|\/)pyproject\.toml$/i.test(path))
    return "python";
  if (/\.(?:[cm]?[jt]s|jsx|tsx)$|(?:^|\/)package\.json$/i.test(path)) return "node";
  if (/\.(sh|bash|zsh)$/i.test(path)) return "bash";
  if (/\.(ps1|psm1)$/i.test(path)) return "powershell";
}

/** Validate limits and CRC before preview; only detected plugins retain non-skill components. */
export async function extractLinkArchive(
  archive: string,
  destination: string,
  subpath: string,
  signal: AbortSignal,
  touch: () => void,
) {
  const entries = await zipEntries(archive, signal, touch, { maxCompressionRatio: 200 });
  const first = entries.files[0]?.path.split("/")[0];
  const wrapper =
    first &&
    !["skills", "plugins", ".claude-plugin", ".codex-plugin"].includes(first) &&
    entries.files.every((file) => file.path.startsWith(`${first}/`))
      ? `${first}/`
      : "";
  const files = entries.files.map((file) => ({ ...file, path: file.path.slice(wrapper.length) }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const roots = new Set<string>();
  const componentPaths = new Set<string>();
  const declaredRoots = new Set<string>();
  const declareSkills = (skills: string | string[] | undefined, prefix: string) => {
    for (const value of typeof skills === "string" ? [skills] : (skills ?? [])) {
      declaredRoots.add((prefix + localPath(value)).replace(/\/$/, ""));
      if (declaredRoots.size > 20_000) throw linkError("skill_link_manifest_invalid");
    }
  };
  const externalSources: SkillLinkListing["externalSources"] = [];
  const components: SkillLinkListing["components"] = {
    mcp: false,
    commands: false,
    externalPlugins: 0,
  };
  const inScope = (path: string) => !subpath || path === subpath || path.startsWith(`${subpath}/`);
  const addRoot = (path: string) => {
    if (inScope(path) && byPath.has(path ? `${path}/SKILL.md` : "SKILL.md")) roots.add(path);
    if (roots.size > 200) throw linkError("skill_link_too_many_skills");
  };
  addRoot(subpath);
  for (const file of files) {
    if (!inScope(file.path)) continue;
    if (/(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(file.path))
      addRoot(dirname(file.path).split("\\").join("/"));
    if (/(?:^|\/)commands\//.test(file.path)) components.commands = true;
    if (/(?:^|\/)\.mcp\.json$/.test(file.path)) components.mcp = true;
    if (!/(?:^|\/)\.claude-plugin\/(?:plugin|marketplace)\.json$/.test(file.path)) continue;
    const raw = await readScannedFile(file, signal, 1024 * 1024, touch);
    let manifest: z.output<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw linkError("skill_link_manifest_invalid");
    }
    const prefix = file.path.slice(0, -`.claude-plugin/${basename(file.path)}`.length);
    components.mcp ||= manifest.mcpServers !== undefined;
    components.commands ||= manifest.commands !== undefined;
    if (basename(file.path) === "plugin.json") {
      componentPaths.add(`${prefix}commands`);
      componentPaths.add(`${prefix}.mcp.json`);
      for (const value of [manifest.commands, manifest.mcpServers]) {
        const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
        if (paths.length > 200) throw linkError("skill_link_manifest_invalid");
        for (const path of paths) {
          if (typeof path !== "string") continue;
          try {
            componentPaths.add((prefix + localPath(path)).replace(/\/$/, ""));
          } catch {
            /* Nonlocal MCP/command references are only reported, never read or followed. */
          }
        }
        if (componentPaths.size > 20_000) throw linkError("skill_link_manifest_invalid");
      }
    }
    if (basename(file.path) === "plugin.json") {
      declareSkills(manifest.skills, prefix);
    } else {
      if (!Array.isArray(manifest.plugins) || manifest.plugins.length > 200)
        throw linkError("skill_link_manifest_invalid");
      for (const item of manifest.plugins) {
        const source = item.source;
        if (typeof source === "string" && source.startsWith("./")) {
          const path = (prefix + localPath(source)).replace(/\/$/, "");
          addRoot(path);
          declareSkills(item.skills, path ? `${path}/` : "");
        } else {
          if (externalSources.length >= 200) throw linkError("skill_link_too_many_skills");
          const url = externalLink(source);
          externalSources.push({
            name: (item.name || "Plugin").slice(0, 80),
            url,
            reason: url ? "confirmation_required" : "unsupported",
          });
          components.externalPlugins++;
        }
      }
    }
  }
  for (const file of files) {
    if (basename(file.path) !== "SKILL.md") continue;
    const parts = file.path.split("/").slice(0, -1);
    for (let n = 0; n <= parts.length; n++) {
      if (declaredRoots.has(parts.slice(0, n).join("/"))) {
        addRoot(parts.join("/"));
        break;
      }
    }
  }
  // A skill collection keeps its individual selection/compatibility flow. Only explicit plugin
  // components or a descriptor at the selected root opt into the host package review.
  const prefix = subpath ? `${subpath}/` : "";
  const pluginPackage =
    components.mcp ||
    components.commands ||
    [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json", ".mcp.json"].some(
      (name) => byPath.has(`${prefix}${name}`),
    );
  if (!pluginPackage && !roots.size && !externalSources.length)
    throw linkError("skill_link_no_skills");
  if (roots.size > 200) throw linkError("skill_link_too_many_skills");
  const candidates: LinkCandidate[] = [];
  const selectedFiles = new Map<string, SkillSourceFile>();
  for (const root of [...roots].sort()) {
    signal.throwIfAborted();
    const documentFile = byPath.get(root ? `${root}/SKILL.md` : "SKILL.md") as SkillSourceFile;
    const text = await readScannedFile(
      documentFile,
      signal,
      SKILL_BODY_MAX_BYTES + 64 * 1024,
      touch,
    );
    let document: ReturnType<typeof importedDocument>;
    try {
      document = importedDocument(
        parseSkillFile(new TextDecoder("utf-8", { fatal: true }).decode(text)),
        basename(root) || "skill",
      );
    } catch {
      throw linkError("skill_link_manifest_invalid");
    }
    const prefix = root ? `${root}/` : "";
    const resources = files.filter(
      (file) => file.path.startsWith(prefix) && !excluded(file.path, componentPaths),
    );
    const runtimes = new Set<LinkCandidate["runtimes"][number]>();
    let bytes = 0;
    for (const file of resources) {
      bytes += file.bytes;
      const tag = runtimeTag(file.path);
      if (tag) runtimes.add(tag);
      selectedFiles.set(file.path, file);
    }
    candidates.push({
      id: randomUUID(),
      path: join(destination, ...root.split("/").filter(Boolean)),
      subpath: root,
      name: document.name,
      description: document.description,
      bytes,
      fileCount: resources.length,
      runtimes: [...runtimes],
    });
  }
  // Skill collections retain the original resource filter; plugin review needs all components.
  // Also consume all other streams to validate their CRC and archive declarations without saving them.
  for (const entry of files) {
    signal.throwIfAborted();
    const target = (
      pluginPackage
        ? inScope(entry.path) &&
          entry.path
            .split("/")
            .every((part) => !/^\.env(?:\.|$)/i.test(part) || part.toLowerCase() === ".env.example")
        : selectedFiles.has(entry.path)
    )
      ? join(destination, ...packagePath(entry.path).split("/"))
      : undefined;
    if (target) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const output = target ? await open(target, "wx", 0o600) : undefined;
    const sanitize =
      basename(entry.path).toLowerCase() === ".env.example" ? envExampleFilter() : undefined;
    try {
      for await (const chunk of entry.chunks(signal, 0, entry.bytes, touch)) {
        signal.throwIfAborted();
        if (output) await output.writeFile(sanitize ? sanitize(chunk) : chunk);
        touch();
      }
    } finally {
      await output?.close();
    }
  }
  return {
    packageRoot: pluginPackage
      ? join(destination, ...subpath.split("/").filter(Boolean))
      : undefined,
    candidates,
    components,
    externalSources,
    commit: /^[a-f0-9]{40}$/.test(entries.archiveComment ?? "")
      ? entries.archiveComment
      : undefined,
  };
}
function excluded(path: string, componentPaths: ReadonlySet<string>) {
  if (
    path
      .split("/")
      .some((part) => /^\.env(?:\.|$)/i.test(part) && part.toLowerCase() !== ".env.example")
  )
    return true;
  if (/(?:^|\/)\.claude-plugin(?:\/|$)/.test(path) || basename(path) === ".mcp.json") return true;
  const parts = path.split("/");
  for (let n = 1; n <= parts.length; n++)
    if (componentPaths.has(parts.slice(0, n).join("/"))) return true;
  return false;
}

const skillsSchema = z
  .union([z.string().max(512), z.array(z.string().max(512)).max(200)])
  .optional();
const manifestSchema = z.looseObject({
  skills: skillsSchema,
  mcpServers: z.unknown().optional(),
  commands: z.unknown().optional(),
  plugins: z
    .array(
      z.looseObject({
        source: z.unknown(),
        name: z
          .string()
          .trim()
          .min(1)
          .transform((name) => name.slice(0, 80))
          .optional(),
        skills: skillsSchema,
      }),
    )
    .max(200)
    .optional(),
});

function externalLink(source: unknown): string | null {
  try {
    if (typeof source === "string") return parseLink(source).url;
    const parsed = z
      .object({
        source: z.enum(["github", "url"]),
        repo: z.string().max(201).optional(),
        ref: z.string().min(1).max(512).optional(),
        path: z.string().max(512).optional(),
        url: z.string().max(2048).optional(),
      })
      .safeParse(source);
    if (!parsed.success) return null;
    const item = parsed.data;
    if (item.source === "url") return item.url ? parseLink(item.url).url : null;
    if (!item.repo || !/^[\w-]+\/[\w.-]+$/.test(item.repo)) return null;
    const path = item.path ? localPath(item.path) : "";
    const tail =
      item.ref || path
        ? `/tree/${encodeURIComponent(item.ref ?? "HEAD")}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`
        : "";
    return parseLink(`https://github.com/${item.repo}${tail}`).url;
  } catch {
    // Unsupported manifest sources are shown as such; they never trigger a network request.
    return null;
  }
}
