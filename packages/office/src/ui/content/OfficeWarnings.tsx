import { useT } from "@pibot/renderer-kit";
import styles from "./office.module.css";

const warningKeys = {
  office_spreadsheet_row_height_limited: "office.warning.rowHeight",
  office_content_preview_partial: "office.warning.partial",
  office_macros_not_executed: "office.warning.macros",
  office_external_links_not_loaded: "office.warning.externalLinks",
  office_formula_cached_not_recalculated: "office.warning.formulas",
  office_fields_not_evaluated: "office.warning.fields",
  macros_not_executed: "office.warning.macros",
  external_links_not_loaded: "office.warning.externalLinks",
  formula_cached_not_recalculated: "office.warning.formulas",
  fields_not_evaluated: "office.warning.fields",
} as const;

export function OfficeWarnings({ warnings }: { warnings: string[] }) {
  const t = useT();
  const keys = new Set(
    warnings.map((code) =>
      Object.hasOwn(warningKeys, code)
        ? warningKeys[code as keyof typeof warningKeys]
        : ("office.warning" as const),
    ),
  );
  if (!keys.size) return null;
  return (
    <ul className={styles.notice}>
      {[...keys].map((key) => (
        <li key={key}>{t(key)}</li>
      ))}
    </ul>
  );
}
