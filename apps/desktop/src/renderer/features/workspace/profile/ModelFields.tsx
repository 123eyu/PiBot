import type { Bot, ModelInfo, Provider } from "@pibot/protocol";
import { useComboboxText, useModelOptions, useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Combobox, SegmentedControl } from "@pibot/ui";
import styles from "../workspace.module.css";

export { normalizedThinking } from "./profile-patch.ts";

export function ModelFields({
  models,
  providers,
  value,
  thinking,
  change,
  disabled,
  creation = false,
}: {
  models: ModelInfo[];
  providers: Provider[];
  value: string;
  thinking: Bot["thinkingLevel"];
  disabled: boolean;
  creation?: boolean;
  change(value: string, thinking?: Bot["thinkingLevel"]): void;
}) {
  const t = useT();
  const { openSettings } = useNavigation();
  const options = useModelOptions(models, providers, true);
  const text = useComboboxText();
  const model = models.find((m) => JSON.stringify([m.provider, m.id]) === value);
  const levels: readonly Bot["thinkingLevel"][] = model?.reasoning
    ? (model.thinkingLevels ?? (["off", "low", "medium", "high"] as const))
    : (["off"] as const);
  return (
    <div className={styles.grid}>
      <Combobox
        {...text}
        label={t("workspace.model")}
        placeholder={t("models.selectModel")}
        options={options}
        value={value}
        disabled={disabled || !models.length}
        onValueChange={(value) => {
          const next = models.find((m) => JSON.stringify([m.provider, m.id]) === value);
          if (next) change(value);
        }}
      />
      {creation ? (
        model?.reasoning &&
        levels.length > 0 && (
          <div>
            <span className={styles.note}>{t("workspace.thinking")}</span>
            <SegmentedControl
              label={t("workspace.thinking")}
              options={levels.map((level) => ({
                value: level,
                label: t(`models.thinking.${level}`),
              }))}
              value={levels.includes(thinking) ? thinking : (levels[0] ?? "off")}
              disabled={disabled}
              onValueChange={(level) => change(value, level)}
            />
          </div>
        )
      ) : (
        <Combobox
          {...text}
          label={t("workspace.thinking")}
          placeholder={t("workspace.thinking")}
          options={levels.map((level) => ({ value: level, label: t(`models.thinking.${level}`) }))}
          value={levels.includes(thinking) ? thinking : (levels[0] ?? "off")}
          disabled={disabled || !model?.reasoning}
          onValueChange={(level) => change(value, level as Bot["thinkingLevel"])}
        />
      )}
      {!models.length && <p className={styles.note}>{t("models.noConfigured")}</p>}
      <div className={styles.modelNote}>
        <span>{t("workspace.modelNote")}</span>
        <Button variant="ghost" disabled={disabled} onClick={() => openSettings("models")}>
          {t("settings.models")}
        </Button>
      </div>
    </div>
  );
}
