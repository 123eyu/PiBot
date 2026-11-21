import type { createTranslator } from "@pibot/i18n";
import type { PlanRelaxation } from "@pibot/protocol";

type T = ReturnType<typeof createTranslator>;
/** One formatter for the confirmation card and the persisted receipt facts. */
export function relaxationText(item: PlanRelaxation, t: T): string {
  const d = item.detail;
  const method = (value: string) =>
    value === "periodic-brief" ? t("receipt.relaxation.periodic-brief") : value;
  const check = (value: NonNullable<PlanRelaxation["check"]>) =>
    value === "citations" ? t("receipt.relaxation.citations") : t(`group.plan.check.${value}`);
  if (!d) return t("receipt.relaxation.legacy");
  switch (d.change) {
    case "output_name":
    case "output_path":
    case "output_id":
    case "check_id":
      return t(`receipt.relaxation.${d.change}`, d);
    case "method_removed":
      return t("receipt.relaxation.method_removed", { method: method(d.method) });
    case "method_changed":
      return t("receipt.relaxation.method_changed", {
        before: method(d.before),
        after: method(d.after),
      });
    case "check_removed":
      return t("receipt.relaxation.check_removed", { check: check(d.check) });
    case "check_changed":
      return t("receipt.relaxation.check_changed", {
        before: check(d.before),
        after: check(d.after),
      });
    case "minimum":
      return t("receipt.relaxation.minimum", d);
    case "columns":
    case "sections":
      return t(`receipt.relaxation.${d.change}`, {
        names: d.removed.join(t("receipt.delivery.separator")),
      });
    case "output_removed":
      return t("receipt.relaxation.output_removed", { path: d.path });
    case "output_kind":
      return t("receipt.relaxation.output_kind", d);
    case "target":
      return t("receipt.relaxation.target", {
        before: d.before ?? t("receipt.relaxation.none"),
        after: d.after ?? t("receipt.relaxation.none"),
      });
    case "manual":
      return t("receipt.relaxation.manual");
  }
}
export function visibleRelaxations(items: readonly PlanRelaxation[], expanded: boolean) {
  return {
    items: expanded ? items : items.slice(0, 5),
    hidden: expanded ? 0 : Math.max(0, items.length - 5),
  };
}
