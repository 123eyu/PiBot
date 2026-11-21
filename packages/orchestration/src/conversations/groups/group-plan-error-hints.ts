import {
  ACCEPTANCE_CHECK_KINDS,
  AcceptanceCheckSchema,
  DeliverableSchema,
  deliverableKind,
} from "@pibot/protocol-base";
import type { z } from "zod";

/**
 * A coordinator that is told only `expected: "custom"` cannot fix its plan, so every
 * schema issue is reported once, in words, with one legal example of that very field. Paths are
 * indices and field names only; received values are never echoed (they may hold file contents).
 */
export interface IssueHint {
  message: string;
  example: string;
}

const STEP_EXAMPLE =
  '{"id":"s1","title":"收集来源","owner":{"botId":"<本群成员 id>"},"task":"…","deliverables":[{"id":"report","path":"report.md","kind":"md"}],"acceptance":[{"id":"a1","check":"exists","deliverable":"report"}]}';
const DELIVERABLE_EXAMPLE =
  '{"id":"report","path":"report.md","kind":"md","sections":["结论","来源"]}';
const CHECK_EXAMPLE = '{"id":"a1","check":"exists","deliverable":"report"}';
const PLAN_EXAMPLE = `{"plan":{"name":"调研报告","estimatedCostUsd":1,"steps":[${STEP_EXAMPLE}]}}`;

const FIELDS: Record<string, string[]> = {
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

const step = (index: unknown) => (typeof index === "number" ? `第 ${index + 1} 步` : "计划");
const stepEn = (index: unknown) => (typeof index === "number" ? `step ${index + 1}` : "the plan");
const nth = (kind: string, index: unknown) =>
  typeof index === "number" ? `第 ${index + 1} 个${kind}` : kind;
const nthEn = (kind: string, index: unknown) =>
  typeof index === "number" ? `${kind} #${index + 1}` : kind;

/** The object a path points into, so "unknown field" can name what is actually allowed. */
function allowed(path: readonly PropertyKey[]): string[] | undefined {
  const [root, , field, , leaf] = path;
  if (root === undefined) return FIELDS.plan;
  if (root !== "steps") return undefined;
  if (path.length === 1) return FIELDS.plan;
  if (field === undefined) return FIELDS.step;
  if (field === "owner") return FIELDS.owner;
  if (field === "deliverables") return leaf === "sections" ? ["<文本>"] : FIELDS.deliverable;
  if (field === "acceptance") return FIELDS.acceptance;
  if (field === "inputs") return FIELDS.input;
  return undefined;
}

const unknownField = (path: readonly PropertyKey[], keys: readonly string[]): IssueHint => {
  const names = allowed(path);
  return {
    message: `${keys.map((key) => key.slice(0, 40)).join("、") || "未知字段"} 不是这里的字段，删掉它们：这里只接受 ${names?.join(" / ") ?? "已定义的字段"} / ${keys.map((key) => key.slice(0, 40)).join(", ") || "unknown field"} is not a field here; remove it. Allowed: ${names?.join(" / ") ?? "the defined fields"}`,
    example:
      path.length === 1
        ? STEP_EXAMPLE
        : names === FIELDS.acceptance
          ? CHECK_EXAMPLE
          : names === FIELDS.deliverable
            ? DELIVERABLE_EXAMPLE
            : "{}",
  };
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const at = (value: unknown, index: unknown) =>
  Array.isArray(value) && typeof index === "number" ? value[index] : undefined;

/**
 * Names the check that did not fit and the kinds it needs. Only enum values and a short
 * extension are echoed back; the old hint listed other checks and the coordinator resubmitted
 * the same plan until the format limit (Linux acceptance 2026-11-21, verdict on calc.sh).
 */
function typeMismatchHint(input: unknown, stepIndex: unknown, index: unknown): IssueHint {
  const plan = record(input);
  const stepValue = record(at(plan?.steps, stepIndex));
  const item = record(at(stepValue?.acceptance, index));
  const check = AcceptanceCheckSchema.safeParse(item?.check);
  const kinds = check.success ? ACCEPTANCE_CHECK_KINDS[check.data] : undefined;
  const target = DeliverableSchema.safeParse(
    Array.isArray(stepValue?.deliverables)
      ? stepValue.deliverables.find((entry) => record(entry)?.id === item?.deliverable)
      : undefined,
  );
  const kind = target.success ? deliverableKind(target.data) : undefined;
  const shown = kind && /^[a-z0-9]{1,8}$/.test(kind) ? kind : undefined;
  const where = `${step(stepIndex)}的${nth("验收项", index)}`;
  const whereEn = `${stepEn(stepIndex)} ${nthEn("acceptance", index)}`;
  if (!check.success || !kinds)
    return {
      message: `${where}的检查类型不适用于这个交付物：换成 exists，或指向能检查的文件 / ${whereEn} does not fit its deliverable: use exists, or point it at a file it can read`,
      example: CHECK_EXAMPLE,
    };
  const need = kinds.join(" / ");
  const file = shown ? `（这里是 ${shown}）` : "";
  const fileEn = shown ? ` (this one is ${shown})` : "";
  return {
    message: `${where}用了 check:"${check.data}"，它只能检查 ${need} 文件${file}：把它指向 ${need} 交付物，或这个文件改用 exists / ${whereEn} uses check:"${check.data}", which only reads ${need} files${fileEn}: point it at a ${need} deliverable, or use exists for this file`,
    example:
      check.data === "verdict"
        ? '{"id":"v1","check":"verdict","deliverable":"review"} + {"id":"review","path":"review.md","kind":"md"}'
        : CHECK_EXAMPLE,
  };
}

export function planFieldHint(issue: z.core.$ZodIssue, input?: unknown): IssueHint | undefined {
  const path = issue.path;
  const [, stepIndex, field, index, leaf] = path;
  if (issue.code === "unrecognized_keys") return unknownField(path, issue.keys);
  if (issue.code === "custom" && issue.message.startsWith("plan_")) {
    switch (issue.message) {
      case "plan_deliverable_missing":
        return {
          message: `${step(stepIndex)}的${nth("验收项", index)}缺 deliverable：写成 {"check":"exists","deliverable":"<交付物 id>"} / ${stepEn(stepIndex)} ${nthEn("acceptance", index)} has no deliverable: write {"check":"exists","deliverable":"<deliverable id>"}`,
          example: CHECK_EXAMPLE,
        };
      case "plan_automatic_check_required":
        return {
          message: `${step(stepIndex)}的${nth("交付物", index)}没有任何自动检查：至少加一条引用它的验收项 / ${stepEn(stepIndex)} ${nthEn("deliverable", index)} has no automatic check: add at least one acceptance item that names it`,
          example: CHECK_EXAMPLE,
        };
      case "plan_output_collision":
        return {
          message:
            "交付物路径与前面某一步相同：给后一个文件名加步骤后缀，使它在整个计划里唯一 / Two steps write the same file: add the step id to the later file name so every path is unique",
          example: '"path": "report-s2.md"',
        };
      case "plan_sections_missing":
        return {
          message:
            '这个交付物没有声明 sections：sections 写在 deliverables 的交付物上，检查项用 check:"sections" 指向它 / The deliverable declares no sections: put sections on the deliverables item and point the check at it',
          example: DELIVERABLE_EXAMPLE,
        };
      case "plan_type_mismatch":
        return typeMismatchHint(input, stepIndex, index);
      case "plan_manual_text_required":
        return {
          message:
            "人工项要写 text：说明让人核对什么 / A manual check needs text describing what the person verifies",
          example: '{"id":"review","check":"manual","text":"核对结论与来源一致"}',
        };
      default:
        break;
    }
  }
  if (path.length === 0)
    return {
      message:
        "计划整体格式不对：提交 {plan:{name,estimatedCostUsd,steps:[…]}}（1–20 步） / The plan shape is wrong: submit {plan:{name,estimatedCostUsd,steps:[…]}} with 1–20 steps",
      example: PLAN_EXAMPLE,
    };
  if (path[0] === "name")
    return {
      message: "计划要有 name（1–200 字的纯文本标题） / The plan needs name, a plain text title",
      example: '"name": "调研报告"',
    };
  if (path[0] === "estimatedCostUsd")
    return {
      message:
        "estimatedCostUsd 要写成数字（不小于 0） / estimatedCostUsd must be a number (0 or more)",
      example: '"estimatedCostUsd": 1.5',
    };
  if (path[0] === "requiresConfirmation")
    return {
      message:
        "requiresConfirmation 只能是 true 或 false / requiresConfirmation must be true or false",
      example: '"requiresConfirmation": true',
    };
  if (path[0] !== "steps") return undefined;
  if (path.length === 1)
    return {
      message:
        "steps 要从第一步开始列成数组，每步至少一个交付物和一条验收项 / steps must be an array of 1–20 steps, each with a deliverable and an acceptance item",
      example: STEP_EXAMPLE,
    };
  if (path.length === 2)
    return {
      message: `${step(stepIndex)}缺字段或类型不对：每步需要 id、title、owner、task、deliverables、acceptance / ${stepEn(stepIndex)} is missing a field or has the wrong type: id, title, owner, task, deliverables, acceptance`,
      example: STEP_EXAMPLE,
    };
  if (field === "owner")
    return {
      message: `${step(stepIndex)}的 owner 只能写 {"botId":"<本群成员 id>"} 或 {"role":"<唯一对应的角色 id>"} / ${stepEn(stepIndex)} owner is {"botId":"<member id>"} or {"role":"<unique role id>"}`,
      example: '{"botId": "<本群成员 id>"}',
    };
  if (field === "deliverables") return deliverableHint(stepIndex, index, leaf);
  if (field === "acceptance") return acceptanceHint(stepIndex, index, leaf);
  if (field === "dependsOn")
    return {
      message: `${step(stepIndex)}的 dependsOn 写前置步骤的 id 数组 / ${stepEn(stepIndex)} dependsOn lists earlier step ids`,
      example: '["s1"]',
    };
  if (field === "inputs")
    return {
      message: `${step(stepIndex)}的 inputs 每项写 {"stepId":…,"deliverableId":…}，且只能引用 dependsOn 里的步骤 / ${stepEn(stepIndex)} inputs are {"stepId":…,"deliverableId":…} of a direct dependency`,
      example: '{"stepId": "s1", "deliverableId": "report"}',
    };
  if (field === "maxFixRounds")
    return {
      message: "maxFixRounds 是 0–2 的整数 / maxFixRounds is an integer 0–2",
      example: '"maxFixRounds": 2',
    };
  if (field === "id")
    return {
      message: `${step(stepIndex)}的 id 用字母、数字、下划线或短横线（1–40 字） / ${stepEn(stepIndex)} id uses letters, digits, _ or - (1–40)`,
      example: '"id": "s1"',
    };
  return undefined;
}

function deliverableHint(stepIndex: unknown, index: unknown, leaf: unknown): IssueHint {
  const message = `${step(stepIndex)}的${nth("交付物", index)}格式不对 / ${stepEn(stepIndex)} ${nthEn("deliverable", index)} is malformed`;
  if (leaf === "path")
    return {
      message: `${message}：path 是相对本步骤产物目录的路径，不能是绝对路径、不能含 .. / path is relative to the step folder: no absolute paths, no ..`,
      example: '"path": "report.md"',
    };
  if (leaf === "kind")
    return {
      message: `${message}：kind 只能是 md、docx、xlsx、pptx 或 any / kind is md, docx, xlsx, pptx or any`,
      example: '"kind": "md"',
    };
  if (leaf === "sections")
    return {
      message: `${message}：sections 是章节标题的数组（1–20 个） / sections is an array of up to 20 section titles`,
      example: '"sections": ["结论", "来源"]',
    };
  if (leaf === "id")
    return {
      message: `${message}：id 用字母、数字、下划线或短横线（1–40 字） / id uses letters, digits, _ or - (1–40)`,
      example: '"id": "report"',
    };
  return { message, example: DELIVERABLE_EXAMPLE };
}

function acceptanceHint(stepIndex: unknown, index: unknown, leaf: unknown): IssueHint {
  const message = `${step(stepIndex)}的${nth("验收项", index)}格式不对 / ${stepEn(stepIndex)} ${nthEn("acceptance", index)} is malformed`;
  if (leaf === "deliverable")
    return {
      message: `${message}：deliverable 填本步骤某个交付物的 id / deliverable is the id of one of this step's deliverables`,
      example: CHECK_EXAMPLE,
    };
  if (leaf === "check")
    return {
      message: `${message}：check 只能是 exists、sections、citations、minCitations、sectionsSourced、tableColumns、hasChart、fileNaming、gbt7714、verdict 或 manual / check is one of exists, sections, citations, minCitations, sectionsSourced, tableColumns, hasChart, fileNaming, gbt7714, verdict, manual`,
      example: CHECK_EXAMPLE,
    };
  if (leaf === "min")
    return {
      message: `${message}：只有 minCitations 带 min（1–200 的整数），别的检查项不要写 min / only minCitations takes min (an integer 1–200)`,
      example: '{"id":"cites","check":"minCitations","deliverable":"report","min":3}',
    };
  if (leaf === "columns")
    return {
      message: `${message}：只有 tableColumns 带 columns（1–20 个不重复列名） / only tableColumns takes columns (1–20 unique names)`,
      example:
        '{"id":"cols","check":"tableColumns","deliverable":"data","columns":["维度","数值"]}',
    };
  return { message, example: CHECK_EXAMPLE };
}
