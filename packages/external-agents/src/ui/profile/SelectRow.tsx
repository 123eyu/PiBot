import { useComboboxText } from "@pibot/renderer-kit";
import { Combobox } from "@pibot/ui";
import { useId } from "react";
import styles from "../agents/agents.module.css";

export type SelectList = { current: string; options: { id: string; name: string }[] };

/** One of the agent's select settings; long lists get a search box and provider groups. */
export function SelectRow({
  label,
  list,
  onChange,
}: {
  label: string;
  list: SelectList;
  onChange(value: string): void;
}) {
  const text = useComboboxText();
  const id = useId();
  // Hundreds of models (OpenCode lists every provider's): a search box, and groups by the
  // provider prefix of `provider/model` ids.
  const searchable = list.options.length > 20;
  return (
    <div className={styles.settingRow}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.settingPicker}>
        <Combobox
          {...text}
          hideLabel
          label={label}
          placeholder={label}
          popupMinWidth={380}
          id={id}
          value={list.current}
          options={list.options.map((option) => ({
            value: option.id,
            label: option.name,
            keywords: [option.id],
            group: searchable && option.id.includes("/") ? option.id.split("/")[0] : undefined,
          }))}
          onValueChange={onChange}
        />
      </div>
    </div>
  );
}
