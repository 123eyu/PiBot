import { Combobox, type ComboboxOption } from "@pibot/ui";
import { useComboboxText } from "./model-options.ts";

export function AppSelect({
  label,
  value,
  options,
  disabled,
  change,
  variant,
  hideLabel,
  searchPlaceholder,
}: {
  label: string;
  value: string;
  options: readonly ComboboxOption[];
  disabled?: boolean;
  change(value: string): void;
  variant?: "field" | "pill" | "badge";
  hideLabel?: boolean;
  searchPlaceholder?: string;
}) {
  const text = useComboboxText();
  return (
    <Combobox
      variant={variant}
      hideLabel={hideLabel}
      {...text}
      searchPlaceholder={searchPlaceholder ?? text.searchPlaceholder}
      label={label}
      placeholder={label}
      value={value}
      options={options}
      disabled={disabled}
      onValueChange={change}
    />
  );
}
