import { dirname, resolve } from "node:path";
import {
  abortable,
  checkWorkflowInputs,
  localWorkspaceFiles,
  skillContract,
  type WorkflowSkill,
  type WorkspaceFileAccess,
} from "@pibot/brain/orchestration-kit";
import {
  DeliverablePathSchema,
  type GroupExecutionPlan,
  GroupExecutionPlanSchema,
  type GroupPlanCard,
  GroupPlanInputError,
  RpcError,
  type SkillContract,
} from "@pibot/protocol-base";

import { ATTACHMENT_INPUT } from "./group-plan-inputs.ts";

const invalid = () => new RpcError(-32602, "group_plan_method_inputs_invalid");

async function inputAccess<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await abortable(operation, signal);
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP"].includes(code))
      throw new RpcError(-32602, "group_plan_method_input_unavailable");
    throw error;
  }
}

/** Folder labels are data, never paths that can select another working root. */
function inputPath(root: string, name: string, files?: WorkspaceFileAccess) {
  if (!DeliverablePathSchema.safeParse(name).success || /[/\\]/.test(name)) throw invalid();
  return (files?.paths.resolve ?? resolve)(root, name);
}

function hasAttachmentInputs(
  plan: GroupExecutionPlan,
  folder: string | undefined,
  files?: WorkspaceFileAccess,
) {
  return (
    !!folder &&
    plan.inputs.some(
      (item) =>
        item.kind === "file" &&
        item.name.startsWith(ATTACHMENT_INPUT) &&
        (files?.paths.dirname ?? dirname)(item.value) === folder,
    )
  );
}

function failure(
  plan: GroupExecutionPlan,
  root: string,
  name: string,
  reason: string,
  files?: WorkspaceFileAccess,
) {
  return new GroupPlanInputError(reason, {
    name: name.slice(0, 200),
    expected: inputPath(root, name, files).slice(0, 4096),
    found: plan.inputs
      .filter((item) => item.name !== name && (item.kind === "file" || item.kind === "folder"))
      .slice(0, 6)
      .map((item) => `${item.kind}: ${item.value}`.slice(0, 4096)),
  });
}

async function folderFailure(
  plan: GroupExecutionPlan,
  root: string,
  name: string,
  value: string,
  signal: AbortSignal,
  files?: WorkspaceFileAccess,
) {
  const access = files ?? localWorkspaceFiles;
  const { isAbsolute, relative, resolve, sep } = access.paths;
  if (!isAbsolute(value)) return "group_plan_method_inputs_invalid";
  const rel = relative(root, value);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    return "group_plan_method_inputs_invalid";
  const info = await inputAccess(access.inspect(value, signal), signal).catch((error: unknown) => {
    signal.throwIfAborted();
    if (error instanceof RpcError && error.message === "group_plan_method_input_unavailable")
      return null;
    throw error;
  });
  if (!info) return "group_plan_method_input_unavailable";
  if (
    info.kind !== "directory" ||
    (await inputAccess(access.canonical(value, signal), signal)) !== resolve(value)
  )
    return "group_plan_method_inputs_invalid";
  const checked = await checkWorkflowInputs(
    {
      inputs: plan.contract.inputs.filter((i) => i.name === name),
      prechecks: plan.contract.prechecks.filter((i) => typeof i !== "string" && i.input === name),
    },
    { [name]: value },
    signal,
    access,
  );
  return checked.failures.length
    ? checked.failures.some((i) => i.reason === "empty")
      ? "group_plan_method_input_empty"
      : "group_plan_method_input_unavailable"
    : undefined;
}

/**
 * A method's folder input may be the same-named folder under the workplace root, the request's
 * copied inputs, or any folder inside the workplace the user named in the message. The
 * plan records which path it bound; containment and readability are checked here, never trusted.
 */
export async function checkMethodFolderInputs(
  plan: GroupExecutionPlan,
  root: string,
  signal: AbortSignal,
  inputFolder?: string,
  files: WorkspaceFileAccess = localWorkspaceFiles,
) {
  const folders = plan.contract.inputs.filter((item) => item.kind === "folder");
  if (!folders.length) return;
  if ((await inputAccess(files.canonical(root, signal), signal)) !== files.paths.resolve(root))
    throw invalid();
  const values = new Map(plan.inputs.map((item) => [item.name, item]));
  let attachmentsChecked = false;
  for (const folder of folders) {
    signal.throwIfAborted();
    const input = values.get(folder.name);
    if (input?.kind !== "folder")
      throw failure(plan, root, folder.name, "group_plan_method_inputs_invalid", files);
    // The request's copied inputs are the only folder this run wrote itself, so they get the
    // stricter file checks; any other folder is validated by folderFailure below.
    if (input.value === inputFolder && !attachmentsChecked) {
      for (const item of plan.inputs.filter(
        (item) =>
          item.kind === "file" &&
          item.name.startsWith(ATTACHMENT_INPUT) &&
          (files?.paths.dirname ?? dirname)(item.value) === inputFolder,
      )) {
        try {
          const info = await inputAccess(files.inspect(item.value, signal), signal);
          if (
            info?.kind !== "file" ||
            info.links !== "1" ||
            (await inputAccess(files.canonical(item.value, signal), signal)) !==
              files.paths.resolve(item.value)
          )
            throw failure(plan, root, folder.name, "group_plan_method_inputs_invalid", files);
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RpcError)) throw error;
          throw failure(plan, root, folder.name, error.message, files);
        }
      }
      attachmentsChecked = true;
    }
    const reason = await folderFailure(plan, root, folder.name, input.value, signal, files);
    if (reason) throw failure(plan, root, folder.name, reason, files);
  }
}

/** Admission freezes method folder declarations and bindings in the existing plan snapshot. */
export async function bindMethodFolderInputs(
  plan: GroupExecutionPlan,
  card: GroupPlanCard,
  root: string,
  roles: ReadonlySet<string>,
  lookup: (botId: string, method: string) => Promise<WorkflowSkill | undefined>,
  signal: AbortSignal,
  inputFolder?: string,
  files?: WorkspaceFileAccess,
): Promise<GroupExecutionPlan> {
  const declarations = new Map(plan.contract.inputs.map((item) => [item.name, item]));
  const inputs = new Map(plan.inputs.map((item) => [item.name, item]));
  const prechecks: SkillContract["prechecks"] = [...plan.contract.prechecks];
  for (const step of card.plan.steps) {
    signal.throwIfAborted();
    if (!step.method) continue;
    const owner = card.owners.find((item) => item.stepId === step.id)?.botId;
    if (!owner) throw invalid();
    const method = step.method.normalize("NFKC").trim();
    const slash = method.indexOf("/");
    const key = slash >= 0 && roles.has(method.slice(0, slash)) ? method.slice(slash + 1) : method;
    const skill = await abortable(lookup(owner, key), signal);
    const contract = skill ? skillContract(skill.document).contract : undefined;
    if (!contract || contract.steps?.length)
      throw new RpcError(-32602, "group_plan_method_unavailable");
    const folders = contract.inputs.filter((item) => item.kind === "folder");
    const names = new Set(folders.map((item) => item.name));
    for (const folder of folders) {
      let value = inputPath(root, folder.name, files);
      const existing = inputs.get(folder.name);
      const declared = declarations.get(folder.name);
      // An explicit binding may name any folder inside the workplace; checkMethodFolderInputs
      // validates containment and readability once the whole plan is assembled.
      if ((existing && existing.kind !== "folder") || (declared && declared.kind !== "folder"))
        throw failure(plan, root, folder.name, "group_plan_method_inputs_invalid", files);
      if (existing) value = existing.value;
      declarations.set(folder.name, {
        ...folder,
        required: folder.required || !!declared?.required,
      });
      inputs.set(folder.name, { name: folder.name, kind: "folder", value });
    }
    for (const rule of contract.prechecks) {
      if (typeof rule === "string" || !names.has(rule.input)) continue;
      if (
        !prechecks.some(
          (item) =>
            typeof item !== "string" && item.check === rule.check && item.input === rule.input,
        )
      )
        prechecks.push(rule);
    }
  }
  const candidate = {
    ...plan,
    contract: { ...plan.contract, inputs: [...declarations.values()], prechecks },
    inputs: [...inputs.values()],
  };
  if (hasAttachmentInputs(candidate, inputFolder, files)) {
    const missing: Array<GroupExecutionPlan["inputs"][number]> = [];
    for (const folder of candidate.contract.inputs.filter((item) => item.kind === "folder")) {
      const input = inputs.get(folder.name);
      // An explicit binding is never silently replaced; absent inferred folders may use copies.
      if (!input || plan.inputs.some((item) => item.name === folder.name)) continue;
      if (await folderFailure(candidate, root, folder.name, input.value, signal, files))
        missing.push(input);
    }
    // One unlabelled attachment bundle cannot identify multiple distinct input periods/folders.
    if (missing.length === 1 && missing[0]) missing[0].value = inputFolder as string;
  }
  const parsed = GroupExecutionPlanSchema.safeParse({
    ...plan,
    contract: { ...plan.contract, inputs: [...declarations.values()], prechecks },
    inputs: [...inputs.values()],
  });
  if (!parsed.success) throw invalid();
  await checkMethodFolderInputs(parsed.data, root, signal, inputFolder, files);
  return parsed.data;
}
