import { z } from "zod";
import {
  AbsolutePathSchema,
  CanonicalTimeSchema,
  WorkspaceSnapshotSchema,
} from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { GrantScopeSchema } from "./grants.ts";
import { CategorySchema } from "./settings.ts";

/** Policy-owned consent shape for unattended work; no scheduler implementation is required. */
export const RoutinePreauthInputSchema = z
  .strictObject({ category: CategorySchema, scope: GrantScopeSchema })
  .refine(({ category, scope }) => {
    if (category === "web") return ["domain", "login", "submit", "paid_image"].includes(scope.kind);
    if (category === "run_command")
      return (
        scope.kind === "programs" &&
        scope.programs.length <= 200 &&
        AbsolutePathSchema.safeParse(scope.root).success
      );
    if (category === "read_file" || category === "list_dir")
      return scope.kind === "folder" && AbsolutePathSchema.safeParse(scope.path).success;
    if (category === "write_file")
      return scope.kind === "workplace" && AbsolutePathSchema.safeParse(scope.root).success;
    if (category === "computer") return scope.kind === "apps";
    if (category === "connector") return scope.kind === "connector";
    if (category === "send_out") return scope.kind === "send_target";
    return false;
  }, "Unsupported preauthorization scope");

export const RoutinePreauthSchema = z.strictObject({
  id: IdSchema,
  routineId: IdSchema,
  operation: RoutinePreauthInputSchema,
  createdAt: CanonicalTimeSchema,
  revokedAt: CanonicalTimeSchema.nullable(),
  workspaceSnapshot: WorkspaceSnapshotSchema.nullable(),
  /**
   * `runner` is still a display-only invalidation, like `workspace`: the difference is
   * that re-picking the folder cannot fix an offline execution target. Older values stay valid.
   */
  invalidReason: z
    .enum(["permission", "workspace", "runner", "isolation", "validation"])
    .optional(),
});
export type RoutinePreauthInput = z.infer<typeof RoutinePreauthInputSchema>;
export type RoutinePreauth = z.infer<typeof RoutinePreauthSchema>;
