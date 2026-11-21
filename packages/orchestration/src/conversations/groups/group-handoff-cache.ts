// Only unchanged local report files may reuse the last in-run handoff check; everything else rechecks.
import { createHash } from "node:crypto";
import { localWorkspaceFiles, type OfficePort } from "@pibot/brain/orchestration-kit";
import type { DeliveryItem } from "@pibot/protocol-base";
import { checkHandoff, handoffPaths } from "./group-handoff-check.ts";
import type { prepareHandoffCheck } from "./group-handoff-context.ts";

type Prepared = Awaited<ReturnType<typeof prepareHandoffCheck>>;
const SIMPLE = new Set(["exists", "sections", "verdict", "fileNaming"]);

async function fingerprint({ record, sources }: Prepared, signal: AbortSignal) {
  const { baseFolder: folder, spec } = record;
  if (!folder || sources.access?.remote || spec.acceptance.some((a) => !SIMPLE.has(a.check)))
    return;
  // Extraction services and evidence/citation checks have other mutable dependencies.
  if (spec.deliverables.some((d) => !/\.md$/iu.test(d.path))) return;
  const access = sources.access ?? localWorkspaceFiles;
  const paths = access.paths;
  const root = paths.resolve(spec.deliveryLocation?.workspaceRoot ?? folder);
  if ((await access.canonical(root, signal)) !== paths.resolve(root)) return;
  const files = new Set([
    ...spec.files.flatMap((file) => handoffPaths(folder, file, paths)),
    ...spec.deliverables.map((file) => paths.resolve(folder, file.path)),
    ...(spec.deliveryLocation?.originals.map((file) => paths.resolve(root, file.original)) ?? []),
    ...spec.files.map((file) => paths.resolve(root, file)),
    ...spec.deliverables.map((file) => paths.resolve(root, file.path)),
  ]);
  for (const file of [...files]) {
    const relative = paths.relative(root, file);
    if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`))
      return;
    let parent = file;
    while (parent !== root) {
      parent = paths.dirname(parent);
      files.add(parent);
    }
  }
  if (files.size > 200) return;
  const states = [];
  for (const file of files) {
    const info = await access.inspect(file, signal);
    if (info?.kind === "blocked") return;
    states.push([file, info]);
  }
  return createHash("sha256").update(JSON.stringify({ folder, spec, states })).digest("hex");
}

export class GroupHandoffCheckCache {
  private readonly shutdown = new AbortController();
  private readonly entries = new Map<string, { fingerprint: string; items: DeliveryItem[] }>();
  constructor(private readonly office: () => OfficePort | undefined) {}

  async check(runId: string, prepared: Prepared, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, this.shutdown.signal]);
    signal.throwIfAborted();
    const before = await this.fingerprint(prepared, signal);
    const cached = this.entries.get(runId);
    if (before && cached?.fingerprint === before) return structuredClone(cached.items);
    this.entries.delete(runId);
    const items = await checkHandoff(prepared.record, this.office(), signal, prepared.sources);
    if (before && before === (await this.fingerprint(prepared, signal))) {
      this.entries.set(runId, { fingerprint: before, items: structuredClone(items) });
      if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value as string);
    }
    return items;
  }

  private async fingerprint(prepared: Prepared, signal: AbortSignal) {
    try {
      return await fingerprint(prepared, signal);
    } catch {
      // A cache probe is optional; the actual checker still decides unreadable files and roots.
      signal.throwIfAborted();
      return undefined;
    }
  }

  delete(runId: string) {
    this.entries.delete(runId);
  }
  stop() {
    this.shutdown.abort();
    this.entries.clear();
  }
}
