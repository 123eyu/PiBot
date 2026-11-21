// The ACP adapters of Codex and Claude Agent are downloaded only when the
// user asks (the "download and create" button), at a pinned version, every tarball checked
// against its SHA-256 before a single byte is unpacked. Nothing is bundled and nothing runs npm.
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { withPublicDownload } from "@pibot/execution";
import {
  ADAPTER_MANIFESTS,
  type AdapterManifest,
  type AdapterTarball,
} from "./adapter-manifest.ts";

type NetworkProxy = Parameters<typeof withPublicDownload>[0]["proxy"];
export type AdapterAgent = keyof typeof ADAPTER_MANIFESTS;

const HOSTS = new Set(["registry.npmjs.org"]);
/** Unpacked bytes of one tarball and of the whole adapter: generous for 9.8 MB of tarballs. */
const MAX_UNPACKED = 96 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const PARALLEL = 6;

export class AdapterInstallError extends Error {
  constructor(readonly reason: "network" | "checksum" | "archive" | "unsupported") {
    super(`adapter_${reason}`);
  }
}

export const isAdapterAgent = (id: string): id is AdapterAgent => id in ADAPTER_MANIFESTS;

/** A path inside a package tarball, as data: no absolute, parent or Windows-separator names. */
function safeRelative(name: string): string | undefined {
  if (!name.startsWith("package/")) return undefined;
  const rel = name.slice("package/".length).replace(/\/+$/, "");
  if (!rel || /[\0\\]/.test(rel) || rel.startsWith("/")) return undefined;
  const normalized = posix.normalize(rel);
  if (normalized !== rel || normalized.split("/").some((part) => part === ".." || part === "."))
    return undefined;
  return normalized;
}

/** Regular files of an npm tarball (ustar with optional pax names); links are never followed. */
function* tarFiles(archive: Buffer): Generator<{ name: string; data: Buffer }> {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED });
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, end: number) =>
      header.toString("utf8", start, end).split("\0")[0] ?? "";
    const base = field(0, 100);
    if (!base) break;
    const length = field(124, 136).trim();
    if (!/^[0-7]+$/.test(length)) throw new AdapterInstallError("archive");
    const size = Number.parseInt(length, 8);
    const start = offset + 512;
    if (size > tar.length - start) throw new AdapterInstallError("archive");
    const type = field(156, 157);
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // Pax extended header: only `path` matters, for the next entry.
      for (const record of data.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) paxPath = match[1];
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = field(345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${base}` : base);
    paxPath = undefined;
    if (type === "" || type === "0") yield { name, data: Buffer.from(data) };
  }
}

/** A tarball naming the same file twice is malformed; never let the later copy win silently. */
async function writeOnce(path: string, data: Buffer) {
  try {
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      throw new AdapterInstallError("archive");
    throw error;
  }
}

export class AdapterStore {
  private readonly flights = new Map<AdapterAgent, Promise<void>>();
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly proxy?: () => NetworkProxy | undefined,
  ) {
    this.root = join(dataDir, "runtimes", "acp-adapters");
  }

  manifest(agent: AdapterAgent): AdapterManifest {
    return ADAPTER_MANIFESTS[agent];
  }

  /** The folder the agent's sandbox may read (never write). */
  folder(agent: AdapterAgent) {
    return join(this.root, agent, ADAPTER_MANIFESTS[agent].version);
  }

  /** The script Pi Bot's own Node runs. */
  entry(agent: AdapterAgent) {
    const manifest: AdapterManifest = ADAPTER_MANIFESTS[agent];
    return manifest.layout.kind === "single"
      ? join(this.folder(agent), "index.mjs")
      : join(this.folder(agent), "node_modules", ...manifest.layout.entry.split("/"));
  }

  async installed(agent: AdapterAgent) {
    try {
      return (await lstat(this.entry(agent))).isFile();
    } catch {
      // Missing (or unreadable) means "download first"; the install path reports real errors.
      return false;
    }
  }

  /** Single flight per agent; a second caller waits for the same download. */
  install(agent: AdapterAgent, signal: AbortSignal): Promise<void> {
    const running = this.flights.get(agent);
    if (running) return running;
    const flight = this.download(agent, signal).finally(() => this.flights.delete(agent));
    this.flights.set(agent, flight);
    return flight;
  }

  /** A download cut off by a crash or quit leaves its stage folder; remove those at startup. */
  async cleanStale() {
    for (const agent of Object.keys(ADAPTER_MANIFESTS) as AdapterAgent[]) {
      const entries = await readdir(join(this.root, agent)).catch(() => [] as string[]);
      for (const entry of entries)
        if (entry.startsWith(".download-") && !this.flights.has(agent))
          await rm(join(this.root, agent, entry), { recursive: true, force: true });
    }
  }

  async remove(agent: AdapterAgent) {
    await this.flights.get(agent)?.catch(() => undefined);
    await rm(join(this.root, agent), { recursive: true, force: true });
  }

  private async fetchTarball(tarball: AdapterTarball, file: string, signal: AbortSignal) {
    const [, url, bytes, sha256] = tarball;
    const hash = createHash("sha256");
    try {
      await withPublicDownload(
        { url, hosts: HOSTS, method: "GET", signal, proxy: this.proxy?.() },
        async (response) => {
          if (!response.ok || !response.body) throw new AdapterInstallError("network");
          const handle = await open(file, "wx", 0o600);
          try {
            let received = 0;
            for await (const chunk of response.body) {
              signal.throwIfAborted();
              received += chunk.length;
              if (received > bytes) throw new AdapterInstallError("checksum");
              hash.update(chunk);
              await handle.writeFile(chunk);
            }
            if (received !== bytes || hash.digest("hex") !== sha256)
              throw new AdapterInstallError("checksum");
          } finally {
            await handle.close();
          }
        },
      );
    } catch (error) {
      if (error instanceof AdapterInstallError || signal.aborted) throw error;
      throw new AdapterInstallError("network");
    }
  }

  private async download(agent: AdapterAgent, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(300_000)]);
    const manifest: AdapterManifest = ADAPTER_MANIFESTS[agent];
    const agentRoot = join(this.root, agent);
    await mkdir(agentRoot, { recursive: true, mode: 0o700 });
    if (await this.installed(agent)) return;
    const stage = await mkdtemp(join(agentRoot, ".download-"));
    try {
      const archives = join(stage, "archives");
      const tree = join(stage, manifest.version);
      await mkdir(archives, { mode: 0o700 });
      await mkdir(tree, { mode: 0o700 });
      const queue = manifest.tarballs.map((tarball, index) => ({ tarball, index }));
      const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift())
          await this.fetchTarball(item.tarball, join(archives, `${item.index}.tgz`), signal);
      });
      await Promise.all(workers);
      let total = 0;
      for (const [index, [install]] of manifest.tarballs.entries()) {
        signal.throwIfAborted();
        const archive = await readFile(join(archives, `${index}.tgz`));
        for (const { name, data } of tarFiles(archive)) {
          total += data.length;
          if (total > MAX_TOTAL) throw new AdapterInstallError("archive");
          if (manifest.layout.kind === "single") {
            if (name !== manifest.layout.file) continue;
            await writeOnce(join(tree, "index.mjs"), data);
            continue;
          }
          const rel = safeRelative(name);
          if (!rel) continue;
          const target = join(tree, "node_modules", ...install.split("/"), ...rel.split("/"));
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeOnce(target, data);
        }
      }
      await rm(archives, { recursive: true, force: true });
      const entry =
        manifest.layout.kind === "single"
          ? join(tree, "index.mjs")
          : join(tree, "node_modules", ...manifest.layout.entry.split("/"));
      if (!(await lstat(entry).catch(() => undefined))?.isFile())
        throw new AdapterInstallError("archive");
      await rename(tree, this.folder(agent));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
