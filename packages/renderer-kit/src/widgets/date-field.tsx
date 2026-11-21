import { DatePicker, type DatePickerLabels, type DatePickerProps } from "@pibot/ui";
import { useMemo } from "react";
import { useSettings } from "../settings/context.ts";

export type DateFieldProps = Omit<DatePickerProps, "labels" | "locale" | "weekStartsOn">;

/**
 * The shared picker in the interface language: Chinese weeks start on Monday (一…日), English on
 * Sunday, and month / weekday names come from Intl in the same locale as the labels.
 */
export function DateField(props: DateFieldProps) {
  const { t, language } = useSettings();
  const mode = props.mode ?? "date";
  const labels = useMemo<DatePickerLabels>(
    () => ({
      placeholder: t(`datePicker.placeholder.${mode}`),
      previousMonth: t("datePicker.previousMonth"),
      nextMonth: t("datePicker.nextMonth"),
      today: t("datePicker.today"),
      tomorrow: t("datePicker.tomorrow"),
      nextMonday: t("datePicker.nextMonday"),
      clear: t("datePicker.clear"),
      time: t("datePicker.time"),
      hour: t("datePicker.hour"),
      minute: t("datePicker.minute"),
    }),
    [t, mode],
  );
  return (
    <DatePicker
      {...props}
      labels={labels}
      locale={language === "zh" ? "zh-CN" : "en-US"}
      weekStartsOn={language === "zh" ? 1 : 0}
    />
  );
}
