import { z } from "zod";
import { IdSchema } from "./ids.ts";
export const CanonicalTimeSchema = z.iso
  .datetime()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
    "Canonical UTC milliseconds required",
  );
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (p) =>
      !/[\0\r\n]/.test(p) &&
      (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)),
    "Absolute path required",
  );
export const ExecutionLocationTargetSchema = z.union([
  z.literal("local"),
  z.string().regex(/^runner:[A-Za-z0-9._-]{1,128}$/),
  z.string().regex(/^acp:[A-Za-z0-9._-]{1,128}$/),
]);
export type ExecutionLocationTarget = z.infer<typeof ExecutionLocationTargetSchema>;
/**
 * A pi session file as stored: relative to the data directory, `bots/<botId>/sessions/<file>`,
 * so a moved or restored data directory keeps its sessions. Absolute values are legacy rows the
 * 0022 migration could not recognise; the agent refuses them unless they are in its own folder.
 */
export const SessionFileSchema = z.union([
  AbsolutePathSchema,
  z
    .string()
    .max(1024)
    .regex(/^bots\/[^/\\\0\r\n]+\/sessions\/[^/\\\0\r\n]+$/)
    .refine(
      (p) => !p.split("/").some((part) => part === "." || part === ".."),
      "Invalid session path",
    ),
]);
export const TimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      if (/^[+-]/.test(value)) return false;
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone");
// Captured canonical roots are an invalidatable ceiling, never independent authority.
export const WorkspaceSnapshotSchema = z
  .strictObject({
    boundaryVersion: z.literal(1),
    location: z
      .strictObject({
        target: ExecutionLocationTargetSchema,
        platform: z.enum(["darwin", "win32", "linux"]),
      })
      .optional(),
    conflict: z.enum(["none", "readonly_overlaps_primary", "boundary_unverified"]),
    roots: z
      .array(
        z.strictObject({
          id: z.union([z.literal("home"), IdSchema]),
          role: z.enum(["primary", "readonly", "writable"]),
          path: AbsolutePathSchema,
          canonicalPath: AbsolutePathSchema,
          device: z.string().max(100).nullable(),
          inode: z.string().max(100).nullable(),
        }),
      )
      .min(1)
      .max(202),
    revision: z.number().int().nonnegative().safe(),
    primaryId: z.union([z.literal("home"), IdSchema]),
    primaryPath: AbsolutePathSchema,
    /** Verified managed worktree source; only the nested primary may remain writable. */
    readonlySource: AbsolutePathSchema.optional(),
    readRoots: z.array(AbsolutePathSchema).min(1).max(202),
    writeRoots: z.array(AbsolutePathSchema).max(5),
    denyWriteRoots: z.array(AbsolutePathSchema).max(202),
  })
  .refine((s) => {
    const primary = s.roots.filter((r) => r.role === "primary");
    const source = s.readonlySource?.replaceAll("\\", "/");
    const nested = source && s.primaryPath.replaceAll("\\", "/").startsWith(`${source}/`);
    const denied = s.roots.filter(
      (r) => r.role === "readonly" && r.canonicalPath !== s.readonlySource,
    );
    return (
      (!s.readonlySource ||
        (nested &&
          s.roots.some((r) => r.role === "readonly" && r.canonicalPath === s.readonlySource))) &&
      primary.length === 1 &&
      s.roots.filter((r) => r.role === "writable").length <= 4 &&
      new Set(s.writeRoots).size === s.writeRoots.length &&
      primary[0]?.id === s.primaryId &&
      primary[0]?.canonicalPath === s.primaryPath &&
      new Set(s.roots.map((r) => r.id)).size === s.roots.length &&
      new Set(s.roots.map((r) => r.canonicalPath)).size === s.roots.length &&
      new Set(s.readRoots).size === s.roots.length &&
      s.readRoots.every((p) => s.roots.some((r) => r.canonicalPath === p)) &&
      new Set(s.denyWriteRoots).size === denied.length &&
      s.denyWriteRoots.every((p) =>
        s.roots.some((r) => r.role === "readonly" && r.canonicalPath === p),
      ) &&
      s.roots.every(
        (r) =>
          s.readRoots.includes(r.canonicalPath) &&
          (r.role !== "readonly" ||
            r.canonicalPath === s.readonlySource ||
            s.denyWriteRoots.includes(r.canonicalPath)),
      ) &&
      (s.conflict === "none" || s.writeRoots.length === 0) &&
      s.writeRoots.every(
        (p) =>
          s.roots.some((r) => r.role !== "readonly" && r.canonicalPath === p) &&
          s.readRoots.includes(p) &&
          !s.denyWriteRoots.includes(p),
      )
    );
  });
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
