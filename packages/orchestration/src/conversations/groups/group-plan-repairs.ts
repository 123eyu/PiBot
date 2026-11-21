import { type Acceptance, acceptanceTargetIssue, type Deliverable } from "@pibot/protocol-base";

/**
 * The plan schema stays the contract, but the mistakes real coordinators repeat are
 * mechanical — a check without its `deliverable`, one path used by two steps, `checkType` for
 * `check`, `"2"` for a number. Repairing them before validation is deterministic and cannot
 * loosen a check (a check only ever gains a target that is compatible with it, and an uncovered
 * deliverable only gains the weakest `exists`). Anything that would change which file a check
 * inspects is left to validation, which now names the exact field and a legal example.
 */
type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isKey = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const list = (owner: Raw, key: string): unknown[] =>
  Array.isArray(owner[key]) ? (owner[key] as unknown[]) : [];

const CHECK_NAMES = new Set<string>([
  "exists",
  "sections",
  "citations",
  "manual",
  "minCitations",
  "sectionsSourced",
  "tableColumns",
  "hasChart",
  "fileNaming",
  "gbt7714",
  "verdict",
]);
const KINDS = new Set(["md", "docx", "xlsx", "pptx", "any"]);

/** Field names a step / item may use; the aliases are spellings seen in submissions. */
const FIELDS: Record<string, readonly string[]> = {
  plan: ["name", "estimatedCostUsd", "requiresConfirmation", "steps"],
  step: [
    "id",
    "title",
    "owner",
    "task",
    "method",
    "dependsOn",
    "inputs",
    "deliverables",
    "acceptance",
    "maxFixRounds",
  ],
  deliverable: ["id", "path", "kind", "sections"],
  acceptance: ["id", "text", "check", "deliverable", "min", "columns"],
  owner: ["botId", "role"],
  input: ["stepId", "deliverableId"],
};
const ALIASES: Record<string, Record<string, string>> = {
  plan: { step: "steps" },
  step: { deliverable: "deliverables" },
  acceptance: { deliverableid: "deliverable", deliverables: "deliverable", checktype: "check" },
  deliverable: { section: "sections", filepath: "path", filename: "path" },
};
const normal = (key: string) => key.toLowerCase().replace(/[\s_-]/gu, "");
/** Ids and paths come from the model; keep note text short and value-free. */
const clip = (value: string) => value.slice(0, 40);

function renameFields(type: string, owner: Raw, notes: string[], at: string) {
  const map = new Map((FIELDS[type] ?? []).map((key) => [normal(key), key]));
  for (const [alias, target] of Object.entries(ALIASES[type] ?? {})) map.set(normal(alias), target);
  for (const key of Object.keys(owner)) {
    if (!Object.hasOwn(owner, key)) continue;
    const target = map.get(normal(key));
    if (!target || target === key || Object.hasOwn(owner, target)) continue;
    owner[target] = owner[key];
    delete owner[key];
    notes.push(`${at}：字段 ${clip(key)} 改名为 ${target} / renamed ${clip(key)} to ${target}`);
  }
}

function numeric(owner: Raw, keys: readonly string[], notes: string[], at: string) {
  for (const key of keys) {
    const value = owner[key];
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value.trim())) continue;
    owner[key] = Number(value.trim());
    notes.push(`${at}：${key} 由字符串改成数字 / ${key} converted from a string to a number`);
  }
}

/** A single object or string where the schema wants a list is unambiguously the same intent. */
function wrap(owner: Raw, key: string, kind: "object" | "string", notes: string[], at: string) {
  const value = owner[key];
  if (value === undefined || Array.isArray(value)) return;
  if (kind === "object" ? !isObject(value) : typeof value !== "string") return;
  owner[key] = [value];
  notes.push(
    `${at}：${key} 需要数组，已包成一项 / ${key} must be an array; wrapped the single value`,
  );
}

/** Uses the shared check rule, so a repair cannot pick a target validation would reject. */
function compatible(check: unknown, item: Raw): boolean {
  if (typeof check !== "string" || !CHECK_NAMES.has(check) || check === "manual") return false;
  if (typeof item.path !== "string" || !KINDS.has(String(item.kind))) return false;
  const target = {
    kind: item.kind,
    path: item.path,
    ...(Array.isArray(item.sections)
      ? {
          sections: item.sections.filter(
            (section): section is string => typeof section === "string",
          ),
        }
      : {}),
  } as Deliverable;
  return acceptanceTargetIssue({ check } as Acceptance, target) === undefined;
}

function uniqueId(items: readonly Raw[], prefix: string) {
  const used = new Set(items.map((item) => item.id));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/** Plan rules 1 and 2: every check names a deliverable, every deliverable has a check. */
function pairChecks(step: Raw, index: number, notes: string[]) {
  const deliverables = list(step, "deliverables").filter(isObject);
  const checks = list(step, "acceptance").filter(isObject);
  const covered = new Set<string>();
  for (const item of checks)
    if (item.check !== "manual" && isKey(item.deliverable)) covered.add(item.deliverable);
  checks.forEach((item, position) => {
    if (item.check === "manual" || Object.hasOwn(item, "deliverable")) return;
    const [only] = deliverables;
    const target =
      deliverables.length === 1 && only && isKey(only.id)
        ? only
        : (deliverables.find(
            (item) => isKey(item.id) && !covered.has(item.id) && compatible(item.check, item),
          ) ?? deliverables.filter((candidate) => compatible(item.check, candidate))[0]);
    if (!target || !isKey(target.id)) return;
    item.deliverable = target.id;
    covered.add(target.id);
    notes.push(
      `第 ${index + 1} 步第 ${position + 1} 个验收项缺 deliverable，已按 ${clip(String(item.check))} 配到 ${target.id} / step ${index + 1} acceptance #${position + 1} had no deliverable; paired ${clip(String(item.check))} with ${target.id}`,
    );
  });
  const checksList = list(step, "acceptance");
  for (const target of deliverables) {
    if (!isKey(target.id) || covered.has(target.id) || checksList.length >= 20) continue;
    checksList.push({
      id: uniqueId(checks, "auto_check"),
      check: "exists",
      deliverable: target.id,
    });
    covered.add(target.id);
    notes.push(
      `第 ${index + 1} 步的交付物 ${target.id} 没有任何自动检查，已补 exists / step ${index + 1} deliverable ${target.id} had no automatic check; added exists`,
    );
  }
}

function repairStep(step: Raw, index: number, notes: string[]) {
  const at = `第 ${index + 1} 步 / step ${index + 1}`;
  renameFields("step", step, notes, at);
  numeric(step, ["maxFixRounds"], notes, at);
  if (isObject(step.owner)) renameFields("owner", step.owner, notes, at);
  wrap(step, "deliverables", "object", notes, at);
  wrap(step, "acceptance", "object", notes, at);
  wrap(step, "dependsOn", "string", notes, at);
  wrap(step, "inputs", "object", notes, at);
  for (const item of list(step, "deliverables").filter(isObject)) {
    renameFields("deliverable", item, notes, at);
    wrap(item, "sections", "string", notes, at);
  }
  for (const item of list(step, "acceptance").filter(isObject)) {
    renameFields("acceptance", item, notes, at);
    numeric(item, ["min"], notes, at);
    if (typeof item.columns === "string")
      item.columns = item.columns
        .split(/[,，、;；]/u)
        .map((column) => column.trim())
        .filter(Boolean);
  }
  for (const item of list(step, "inputs").filter(isObject)) renameFields("input", item, notes, at);
  pairChecks(step, index, notes);
}

/** Rule 3: two steps writing the same file is resolvable by one step-id suffix. */
function repairPaths(steps: readonly Raw[], notes: string[]) {
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    for (const item of list(step, "deliverables").filter(isObject)) {
      if (typeof item.path !== "string") continue;
      const key = item.path.normalize("NFKC").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      const suffix = isKey(step.id) ? step.id : `step${index + 1}`;
      let path = withSuffix(item.path, suffix);
      let n = 2;
      while (seen.has(path.normalize("NFKC").toLowerCase()))
        path = withSuffix(item.path, `${suffix}-${n++}`);
      item.path = path;
      seen.add(path.normalize("NFKC").toLowerCase());
      notes.push(
        `第 ${index + 1} 步的交付物路径与前面重复，已改名为 ${clip(path)} / step ${index + 1} reused an earlier path; renamed it to ${clip(path)}`,
      );
    }
  });
}

/**
 * The engine dispatches every ready step at once, but coordinators chain steps into a line.
 * A dependency the step never reads from (no input references that step's deliverable) is a fake
 * ordering constraint — unless the step is a review/test/summary step, which legitimately depends
 * on finished work it does not read as an input.
 */
const DEPENDENT_KINDS =
  /审查|审核|检查|测试|核对|汇总|总结|\b(?:review(?:s|ed|ing)?|audit(?:s|ed|ing)?|verif(?:y|ies|ied|ying|ication)|test(?:s|ed|ing)?|check(?:s|ed|ing)?|summary|summaries|summari[sz](?:e[sd]?|ing|ation)|aggregat(?:e[sd]?|ing|ions?))\b/iu;

function repairDependencies(steps: readonly Raw[], notes: string[]): number {
  const outputs = new Map<string, Set<string>>();
  for (const step of steps)
    if (isKey(step.id))
      outputs.set(
        step.id,
        new Set(
          list(step, "deliverables")
            .filter(isObject)
            .map((item) => String(item.id ?? "")),
        ),
      );
  let dropped = 0;
  steps.forEach((step, index) => {
    if (!Array.isArray(step.dependsOn)) return;
    const label = `${String(step.title ?? "")} ${String(step.task ?? "")}`;
    if (DEPENDENT_KINDS.test(label)) return;
    const read = new Set(
      list(step, "inputs")
        .filter(isObject)
        .map((input) => `${String(input.stepId ?? "")}/${String(input.deliverableId ?? "")}`),
    );
    step.dependsOn = (step.dependsOn as unknown[]).filter((dependency: unknown) => {
      if (typeof dependency !== "string") return true;
      const produced = outputs.get(dependency);
      if (!produced) return true;
      // The step reads nothing this predecessor produces, so the ordering is only cosmetic.
      if ([...produced].some((id) => read.has(`${dependency}/${id}`))) return true;
      dropped += 1;
      notes.push(
        `第 ${index + 1} 步没有用到 ${clip(dependency)} 的产物，已去掉这个依赖（可与其他步骤同时进行）/ step ${index + 1} never read ${clip(dependency)}; dropped that dependency so both can run in parallel`,
      );
      return false;
    });
  });
  return dropped;
}

/**
 * A step that reads another step's output must run after it. Models often list only the nearest
 * step in dependsOn (review depends on test but reads the implementation), which the schema used
 * to reject on the first call; the missing edge is added unless it would make a cycle.
 */
function repairInputDependencies(steps: readonly Raw[], notes: string[]) {
  const byId = new Map(
    steps.filter((step) => isKey(step.id)).map((step) => [String(step.id), step]),
  );
  const after = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const step = byId.get(from);
    return list(step ?? {}, "dependsOn").some(
      (dependency) => typeof dependency === "string" && after(dependency, target, seen),
    );
  };
  steps.forEach((step, index) => {
    if (!isKey(step.id)) return;
    const own = String(step.id);
    const dependsOn = Array.isArray(step.dependsOn) ? (step.dependsOn as unknown[]) : [];
    for (const input of list(step, "inputs").filter(isObject)) {
      const source = typeof input.stepId === "string" ? input.stepId : "";
      if (!source || source === own || !byId.has(source) || dependsOn.includes(source)) continue;
      // The source already waiting on this step would turn the new edge into a cycle.
      if (after(source, own)) continue;
      dependsOn.push(source);
      notes.push(
        `第 ${index + 1} 步读取 ${clip(source)} 的产物，已把 ${clip(source)} 加进它的 dependsOn / step ${index + 1} reads ${clip(source)}'s output; added ${clip(source)} to its dependsOn`,
      );
    }
    if (dependsOn.length) step.dependsOn = dependsOn;
  });
}

function withSuffix(path: string, suffix: string) {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0
    ? `${folder}${file.slice(0, dot)}-${suffix}${file.slice(dot)}`
    : `${folder}${file}-${suffix}`;
}

export function repairGroupPlan(value: unknown): {
  value: unknown;
  notes: string[];
  droppedDependencies: number;
} {
  const notes: string[] = [];
  let plan: unknown;
  try {
    // A JSON round trip gives plain data and never mutates the caller's object.
    plan = JSON.parse(JSON.stringify(value));
  } catch {
    return { value, notes, droppedDependencies: 0 };
  }
  if (!isObject(plan)) return { value: plan, notes, droppedDependencies: 0 };
  renameFields("plan", plan, notes, "计划 / plan");
  numeric(plan, ["estimatedCostUsd"], notes, "计划 / plan");
  wrap(plan, "steps", "object", notes, "计划 / plan");
  const steps = list(plan, "steps").filter(isObject);
  steps.forEach((step, index) => {
    repairStep(step, index, notes);
  });
  repairPaths(steps, notes);
  repairInputDependencies(steps, notes);
  const droppedDependencies = repairDependencies(steps, notes);
  return { value: plan, notes, droppedDependencies };
}
