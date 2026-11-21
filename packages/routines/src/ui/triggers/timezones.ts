import type { ComboboxOption } from "@pibot/ui";

// The system catalog is immutable and shared; typing in the dropdown never rebuilds it.
const catalog = Object.freeze(["UTC", ...Intl.supportedValuesOf("timeZone")]);

export function timezoneOptions(system: string, selected: string): readonly ComboboxOption[] {
  // ICU's canonical list omits valid aliases. Keep the saved spelling, not just its canonical form.
  return [...new Set([system, selected, ...catalog])]
    .filter(Boolean)
    .map((value) => ({ value, label: value, keywords: [value.replaceAll("_", " ")] }));
}
