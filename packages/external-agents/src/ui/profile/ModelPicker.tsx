import { useT } from "@pibot/renderer-kit";
import { Switch } from "@pibot/ui";
import { useId, useMemo } from "react";
import styles from "../agents/agents.module.css";
import { closestVariant, modelFamilies, parseVariant, variantControls } from "./model-variants.ts";
import { type SelectList, SelectRow } from "./SelectRow.tsx";

/**
 * The model picker: one entry per model, and the variants the agent lists for it (Cursor's
 * `composer-2.5[fast=true]`) as switches below when it lists more than one. Cursor usually lists
 * one value per model, so a Fast value is named in the entry instead. Every choice is an id
 * exactly as the agent advertised it, and the exact value is shown under the picker.
 */
export function ModelPicker({
  label,
  list,
  onChange,
}: {
  label: string;
  list: SelectList;
  onChange(value: string): void;
}) {
  const t = useT();
  const id = useId();
  const families = useMemo(() => modelFamilies(list.options), [list.options]);
  const family = families.find((item) => item.variants.some((v) => v.id === list.current));
  const current = family?.variants.find((variant) => variant.id === list.current);
  const params = current?.params ?? parseVariant(list.current).params;
  // Each model stands for the variant closest to the current one, so switching models keeps Fast.
  const entries = families.map((item) => {
    const variant = item === family && current ? current : closestVariant(item, params);
    // Cursor names `composer-2.5[fast=true]` just "composer-2.5": say Fast where the value has it.
    const fast = variant.params.fast === "true" && !/fast/iu.test(item.name);
    return {
      id: variant.id,
      name: fast ? `${item.name} · ${t("externalAgents.session.fast")}` : item.name,
    };
  });
  // A typed id the agent did not list is still the current choice.
  if (!family && list.current) entries.unshift({ id: list.current, name: list.current });
  const controls = family && current ? variantControls(family, current) : [];
  const pick = (key: string, value: string) => {
    if (!family) return;
    const next = closestVariant(family, { ...params, [key]: value }, key);
    if (next.id !== list.current) onChange(next.id);
  };
  return (
    <>
      <SelectRow
        label={label}
        list={{ current: list.current, options: entries }}
        onChange={onChange}
      />
      {controls.map((control) => {
        const name = control.key === "fast" ? t("externalAgents.session.speed") : control.key;
        return (
          <div className={styles.settingRow} key={control.key}>
            <label htmlFor={`${id}-${control.key}`}>{name}</label>
            {control.kind === "toggle" ? (
              <span className={styles.variantSwitch}>
                <Switch
                  id={`${id}-${control.key}`}
                  label={control.key === "fast" ? t("externalAgents.session.fast") : control.key}
                  checked={control.on}
                  onCheckedChange={(on) => pick(control.key, on ? "true" : "false")}
                />
                <span>
                  {control.key === "fast"
                    ? t(
                        control.on
                          ? "externalAgents.session.fastOn"
                          : "externalAgents.session.fastOff",
                      )
                    : control.key}
                </span>
              </span>
            ) : (
              <select
                id={`${id}-${control.key}`}
                value={control.value}
                onChange={(event) => pick(control.key, event.currentTarget.value)}
              >
                {control.values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
      {/* The exact value when the name hides part of it (Cursor's `[…]`) or it was typed. */}
      {list.current && (!current || current.id.includes("[")) && current?.name !== list.current && (
        <p className={styles.note}>
          {t("externalAgents.session.modelValue")}{" "}
          <code className={styles.mono}>{list.current}</code>
        </p>
      )}
    </>
  );
}
