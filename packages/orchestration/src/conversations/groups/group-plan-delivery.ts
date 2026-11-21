import pathApi from "node:path";
import {
  folderName,
  resolveWorkflowFolder,
  type WorkspaceFileAccess,
  workflowOutputRoots,
} from "@pibot/brain/orchestration-kit";
import {
  DeliverablePathSchema,
  GROUP_PLAN_MAX_CHARS,
  GroupPlanToolSchema,
  type PlanDelivery,
  SkillContractSchema,
} from "@pibot/protocol-base";

const period = /^\d{4}-(?:\d{2}-\d{2}|W\d{2}|\d{2})(?:-\d{1,3})?$/;

/** Strip every repeated prefix now, so replanning cannot change an already canonical step. */
function canonicalPath(path: string, name: string, folder: string, paths = pathApi) {
  const equal = (a: string, b: string) =>
    paths.sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const roots = new Set(workflowOutputRoots().map((root) => root.toLowerCase()));
  let value = path;
  while (value) {
    if (folder && equal(value.slice(0, folder.length + 1), `${folder}/`)) {
      value = value.slice(folder.length + 1);
      continue;
    }
    const parts = value.split("/");
    // `.pibot/out` is two segments; the older roots are one.
    const two = `${parts[0] ?? ""}/${parts[1] ?? ""}`.toLowerCase();
    if (roots.has(two)) parts.splice(0, 2);
    else if (roots.has(parts[0]?.toLowerCase() ?? "")) parts.shift();
    else break;
    if (equal(parts[0] ?? "", folderName(name))) {
      parts.shift();
      if (period.test(parts[0] ?? "")) parts.shift();
    }
    value = parts.join("/");
  }
  return DeliverablePathSchema.safeParse(value).data;
}

/** Do not resolve away traversal before validating it; removing a prefix must never hide `..`. */
export function relativeDeliveryPath(
  path: string,
  name: string,
  delivery: Pick<PlanDelivery, "workspaceRoot" | "folder">,
  access?: WorkspaceFileAccess,
) {
  const paths = access?.paths ?? pathApi;
  const { relative, isAbsolute, resolve, sep } = paths;
  const equal = (a: string, b: string) =>
    sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const portable = (path: string) => path.split(sep).join("/");
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  const folder = portable(relative(delivery.workspaceRoot, delivery.folder));
  if (isAbsolute(path)) {
    const prefix = `${portable(resolve(delivery.folder))}/`;
    const value = portable(path);
    if (!equal(value.slice(0, prefix.length), prefix)) return undefined;
    return canonicalPath(value.slice(prefix.length), name, folder, paths);
  }
  // A foreign absolute path must not become a relative path on another platform.
  if (/^[A-Za-z]:|^\\|\\/.test(path)) return undefined;
  return canonicalPath(path, name, folder, paths);
}

/** Plan validation chooses without creating directories, so confirmation and execution refer to one folder. */
export async function preparePlanDelivery(
  value: unknown,
  workspaceRoot: string,
  signal: AbortSignal,
  previous?: PlanDelivery,
  access?: WorkspaceFileAccess,
): Promise<{
  value: unknown;
  delivery?: PlanDelivery;
  issues?: { code: string; path: (string | number)[]; expected: string }[];
}> {
  const { relative, isAbsolute, sep } = access?.paths ?? pathApi;
  signal.throwIfAborted();
  const parsed = GroupPlanToolSchema.safeParse(value);
  if (!parsed.success) return { value };
  const input = parsed.data;
  if (JSON.stringify(value).length > GROUP_PLAN_MAX_CHARS) return { value };
  const wrongRoot = () => ({
    value,
    issues: [
      {
        code: "plan_delivery_workplace_changed",
        path: [] as (string | number)[],
        expected:
          "Keep the original artifact folder inside the current workplace / 原产物目录须仍在当前工作区内",
      },
    ],
  });
  if (previous && previous.workspaceRoot !== workspaceRoot) return wrongRoot();
  const place = await resolveWorkflowFolder(
    workspaceRoot,
    {
      name: input.name,
      contract: SkillContractSchema.parse({}),
      ...(previous ? { folder: previous.folder } : {}),
    },
    signal,
    undefined,
    access,
  );
  const inside = relative(workspaceRoot, place.folder);
  if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
    return wrongRoot();
  const delivery: PlanDelivery = { workspaceRoot, folder: place.folder, rewrites: [] };
  signal.throwIfAborted();
  const issues: { code: string; path: (string | number)[]; expected: string }[] = [];
  const steps = input.steps.map((step, index) => ({
    ...step,
    deliverables: step.deliverables.map((item, n) => {
      const path = relativeDeliveryPath(item.path, input.name, delivery, access);
      if (!path) {
        issues.push({
          code: "plan_delivery_path_invalid",
          path: ["steps", index, "deliverables", n, "path"],
          expected:
            "Relative file path inside the artifact folder; no traversal / 产物目录内的相对文件路径，不得越界",
        });
        return item;
      }
      if (path !== item.path)
        delivery.rewrites.push({
          stepId: step.id,
          deliverableId: item.id,
          from: item.path,
          to: path,
        });
      return { ...item, path };
    }),
  }));
  const key = (stepId: string, id: string) => `${stepId}/${id}`;
  const paths = new Map(
    steps.flatMap((step) =>
      step.deliverables.map((item) => [key(step.id, item.id), item.path] as const),
    ),
  );
  const rewritten = new Set(delivery.rewrites.map((item) => key(item.stepId, item.deliverableId)));
  for (const rewrite of previous?.rewrites ?? []) {
    const id = key(rewrite.stepId, rewrite.deliverableId);
    if (paths.get(id) === rewrite.to && !rewritten.has(id)) delivery.rewrites.push(rewrite);
  }
  return {
    value: { ...input, steps },
    delivery,
    ...(issues.length ? { issues: issues.slice(0, 20) } : {}),
  };
}
