import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OfficeCompareFormat, OfficeComparePort } from "@pibot/office-contract";
import { containsPath } from "@pibot/policy";
import type { ChangesDiff, MethodParams } from "@pibot/workspaces-contract/full";
import { type ChangesScope, changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { prepare } from "../write/changes-write.ts";
import { content } from "./changes-content.ts";

/** Same ceiling as an in-place Office write: a bigger document is not compared object by object. */
const MAX_BYTES = 100 * 1024 * 1024;
const FORMATS = new Map<string, OfficeCompareFormat>([
  ["docx", "docx"],
  ["xlsx", "xlsx"],
  ["pptx", "pptx"],
]);

export function officeFormat(path: string) {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : FORMATS.get(path.slice(dot + 1).toLowerCase());
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

type Source = Pick<MethodParams["changes.diff"], "path" | "scope" | "commit" | "runId">;

/**
 * Adds the per-object list to a binary diff of a Word / Excel / PowerPoint file. The
 * digest names the newer side the list was built from, so a revert can refuse a file that changed
 * elsewhere in the meantime.
 */
export async function withOffice(
  service: ChangesService,
  scope: ChangesScope,
  source: Source,
  diff: ChangesDiff,
  signal: AbortSignal,
): Promise<ChangesDiff> {
  const format = officeFormat(source.path);
  const port = service.office;
  if (!format || !diff.binary || !port) return diff;
  try {
    const before = await content(service, scope, source, "before", MAX_BYTES, signal);
    const after = await content(service, scope, source, "after", MAX_BYTES, signal);
    // One missing or oversized side leaves nothing to compare; the file stays a binary change.
    if (before.state !== "ok" || after.state !== "ok") return diff;
    const result = await port.diff({ format, before: before.bytes, after: after.bytes, signal });
    return {
      ...diff,
      office: { items: result.items, omitted: result.omitted, digest: sha256(after.bytes) },
    };
  } catch {
    signal.throwIfAborted();
    // A document this build cannot parse is still a binary change; only the file actions remain.
    service.local.deps.logger.warn("Office change comparison failed");
    return diff;
  }
}

/**
 * Takes one object back to the older version. The newer side must still hash to the digest the
 * panel saw, otherwise the splice would land on content the user is not looking at.
 */
export async function discardOffice(
  service: ChangesService,
  params: MethodParams["changes.discardOffice"],
  signal: AbortSignal,
): Promise<{ ok: true }> {
  const format = officeFormat(params.path);
  const port = service.office;
  if (!format || !port) throw changesError("changes_office_unsupported");
  const scope = await service.scope(params, signal);
  // Same guards as a file-level discard: writable root, no run writing it, working isolation.
  await prepare(service, scope, signal);
  const root = scope.root.path;
  const after = await content(service, scope, params, "after", MAX_BYTES, signal);
  const before = await content(service, scope, params, "before", MAX_BYTES, signal);
  if (after.state !== "ok" || before.state !== "ok") throw changesError("changes_stale");
  // The list described this scope's newer side; the file on disk must still be that side, or the
  // splice would land on content the reader is not looking at.
  const current = await content(
    service,
    scope,
    { ...params, scope: "uncommitted" },
    "after",
    MAX_BYTES,
    signal,
  );
  if (current.state !== "ok" || sha256(current.bytes) !== params.digest)
    throw changesError("changes_stale");
  const bytes = await port.restore({
    format,
    before: before.bytes,
    after: after.bytes,
    item: params.item,
    signal,
  });
  if (!bytes) throw changesError("changes_office_unrestorable");
  const absolute = join(root, ...params.path.split("/"));
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isFile()) throw changesError("changes_stale");
  if (!containsPath(await realpath(root), await realpath(dirname(absolute)), service.platform))
    throw changesError("changes_stale");
  const target = service.local.target;
  const replace = target.replaceBinary;
  if (!replace) throw changesError("changes_office_unsupported");
  const write = (bound: AbortSignal, assertCurrent: () => void) =>
    replace.call(target, {
      path: absolute,
      expectedPath: absolute,
      bytes,
      expectedRevision: params.digest,
      expectedMode: Number(info.mode & 0o777),
      cwd: root,
      writeRoots: [root],
      rootIdentities: [{ canonicalPath: root, device: scope.root.device, inode: scope.root.inode }],
      signal: bound,
      assertCurrent,
      revalidate: async () => assertCurrent(),
    });
  const lease = service.userWriteLease;
  if (lease)
    await lease(scope, signal, (bound, assertAuthorized) => write(bound, assertAuthorized));
  else await write(signal, () => undefined);
  service.forget(root);
  service.notify(scope);
  service.local.approvals.audit.append({
    botId: scope.botId,
    kind: "file.written",
    summary: "Office change reverted / 已撤回一处 Office 改动",
    detail: {
      toolName: "changes.discardOffice",
      actor: "user",
      cwd: root,
      path: params.path,
      target: params.item,
    },
  });
  return { ok: true as const };
}
