import type { Bot } from "@pibot/protocol-base";
import { isVerdictRole } from "@pibot/teams-contract";

type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);

function uniqueId(items: readonly unknown[], prefix: string) {
  const used = new Set(items.filter(object).map((item) => item.id));
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}

export function withVerdictRequirement(value: unknown, owner: Bot | undefined): unknown {
  if (!object(value) || !isVerdictRole(owner?.role?.id)) return value;
  const acceptance = Array.isArray(value.acceptance) ? value.acceptance : [];
  if (acceptance.some((item) => object(item) && item.check === "verdict")) return value;
  const deliverables = Array.isArray(value.deliverables) ? value.deliverables : [];
  const target = deliverables.find(
    (item) =>
      object(item) &&
      (item.kind === "md" ||
        (item.kind === "any" && typeof item.path === "string" && /\.md$/iu.test(item.path))),
  );
  const report = object(target)
    ? target
    : {
        id: uniqueId(deliverables, "report"),
        path: `report-${typeof value.id === "string" ? value.id : "verification"}.md`,
        kind: "md",
      };
  return {
    ...value,
    deliverables: target ? deliverables : [...deliverables, report],
    acceptance: [
      ...acceptance,
      {
        id: uniqueId(acceptance, "verdict"),
        check: "verdict",
        deliverable: report.id,
      },
    ],
  };
}
