import { z } from "zod";

const path = z.string().min(1).max(4096);
const root = z.object({ path, device: z.string().optional(), inode: z.string().optional() });
const reason = z.enum([
  "invalid_input",
  "outside_scope",
  "protected",
  "unreadable",
  "alias",
  "hardlink",
  "changed_during_read",
  "unsupported_layout",
  "config_includes_unknown",
  "entry_limit",
  "depth_limit",
  "repository_limit",
  "time_limit",
  "file_limit",
  "issue_limit",
]);
const limits = z.object({
  maxEntries: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative(),
  maxRepositories: z.number().int().nonnegative(),
  timeoutMs: z.number().int().nonnegative(),
  maxFileBytes: z.number().int().nonnegative(),
});
const identity = z.object({
  path,
  device: z.string(),
  inode: z.string(),
  size: z.string(),
  modifiedNs: z.string(),
  changedNs: z.string(),
  links: z.string(),
  type: z.enum(["directory", "file", "symlink", "other"]),
});
const scope = z.enum([
  "write",
  "readonly",
  "registered",
  "global",
  "system",
  "outside",
  "protected",
]);
const resource = z.object({
  id: z.string().min(1).max(8192),
  path,
  scope,
  kind: z.enum([
    "root",
    "git-marker",
    "git-directory",
    "common-directory",
    "pointer",
    "config",
    "manifest",
    "hooks",
    "objects",
    "index",
    "refs",
    "head",
    "fresh-target",
    "global-config",
    "system-config",
  ]),
  exists: z.boolean(),
  identity: identity.optional(),
  parentIdentity: identity.optional(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** Internal diagnostic facts only. No request or approval schema accepts this as authority. */
export const GitResourceFactsSchema = z.object({
  version: z.literal(1),
  input: z.object({
    targetsOnly: z.literal(true).optional(),
    cwd: path,
    writeRoots: z.array(root).max(32),
    readOnlyRoots: z.array(root).max(32).optional(),
    targets: z.array(path).max(64).optional(),
    trustedGitLocations: z
      .array(z.object({ path, kind: z.enum(["metadata", "global", "system"]) }))
      .max(64)
      .optional(),
    protectedRoots: z.array(path).max(256).optional(),
    limits: limits.partial().optional(),
  }),
  coverage: z.object({
    state: z.enum(["complete", "incomplete"]),
    knownRoots: z.array(path).max(32),
    knownLayouts: z.array(z.string()).max(7),
    unresolved: z.array(z.object({ path, reason })).max(128),
    limitsReached: z.array(reason),
    futureLayoutProtection: z.literal("none"),
  }),
  repositories: z
    .array(
      z.object({
        kind: z.enum(["ordinary", "gitfile", "worktree", "submodule", "bare", "fresh", "metadata"]),
        scope,
        worktree: path.optional(),
        gitDir: path.optional(),
        commonDir: path.optional(),
        resourceIds: z.array(z.string()).max(32),
      }),
    )
    .max(128),
  resources: z.array(resource).max(4096),
  platformCapabilities: z.object({
    platform: z.enum(["darwin", "linux", "win32", "other"]),
    inspection: z.literal("read-only"),
    commandIsolation: z.enum(["not-evaluated", "windows-unisolated"]),
    authority: z.literal("none"),
  }),
});
export type GitResourceFacts = z.infer<typeof GitResourceFactsSchema>;
