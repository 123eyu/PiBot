import type { Language, TranslationKey } from "@pibot/i18n";
import { ProviderForm, type Task } from "@pibot/models/ui";
import type { ModelInfo, Provider } from "@pibot/protocol";
import { modelDisplayName, useComboboxText, useT } from "@pibot/renderer-kit";
import {
  type BrandGlyph,
  Combobox,
  type ComboboxOption,
  type IconName,
  type Tone,
} from "@pibot/ui";
import { useState } from "react";
import shared from "../../../../../../packages/renderer-kit/src/widgets/setup/setup.module.css";
import styles from "./welcome.module.css";

/**
 * One recommended route for a new user, by the language they chose (maintainers 2026-11-19):
 * Chinese starts with DeepSeek's own API, English with OpenRouter (one key for many vendors, free
 * models too). Either way the preselected model is cheap and handles tool calls well.
 */
export interface RecommendedRoute {
  provider: string;
  model: string;
  keyUrl: string;
  label: TranslationKey;
  note: TranslationKey;
  privacy: TranslationKey;
  getKey: TranslationKey;
  mark: { icon: IconName; brand?: never } | { brand: BrandGlyph; icon?: never };
  tone: Tone;
}
export const RECOMMENDED_ROUTES: Record<Language, RecommendedRoute> = {
  zh: {
    provider: "deepseek",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    label: "welcome.model.deepseek",
    note: "welcome.model.deepseekShort",
    privacy: "welcome.model.deepseekPrivacy",
    getKey: "welcome.model.deepseekGetKey",
    mark: { brand: "deepseek" },
    tone: "blue",
  },
  en: {
    provider: "openrouter",
    model: "~deepseek/deepseek-v4-flash-latest",
    keyUrl: "https://openrouter.ai/keys",
    label: "welcome.model.openrouter",
    note: "welcome.model.openrouterShort",
    privacy: "welcome.model.recommendedPrivacy",
    getKey: "welcome.model.getKey",
    mark: { icon: "network" },
    tone: "violet",
  },
};

export function RecommendedSetup({
  route,
  provider,
  epoch,
  task,
  refresh,
  onDirtyChange,
  selected,
  value,
  options,
  disabled,
  change,
}: {
  route: RecommendedRoute;
  provider?: Provider;
  epoch: number;
  task: Task;
  refresh(): Promise<void>;
  onDirtyChange(dirty: boolean): void;
  selected?: ModelInfo;
  value: string;
  options: ComboboxOption[];
  disabled: boolean;
  change(value: string): void;
}) {
  const t = useT();
  const comboboxText = useComboboxText();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <p className={shared.note}>
        {t(route.privacy)}{" "}
        <a className={styles.link} href={route.keyUrl} target="_blank" rel="noreferrer">
          {t(route.getKey)}
        </a>
      </p>
      {provider && (
        <ProviderForm
          key={`${epoch}:${provider.id}`}
          provider={provider}
          testModelId={route.model}
          task={task}
          refresh={refresh}
          onDirtyChange={onDirtyChange}
          compact
        />
      )}
      {selected && !picking && (
        <p className={shared.note}>
          {t("welcome.model.recommendedModel", { name: modelDisplayName(selected.name) })}{" "}
          <button
            type="button"
            className={styles.textButton}
            disabled={disabled}
            onClick={() => setPicking(true)}
          >
            {t("welcome.model.changeModel")}
          </button>
        </p>
      )}
      {/* The picker opens by itself when the recommended model is missing from the catalog. */}
      {!!options.length && (picking || !selected) && (
        <Combobox
          {...comboboxText}
          label={t("models.defaultModel")}
          placeholder={t("setup.chooseModel")}
          options={options}
          value={selected ? value : ""}
          disabled={disabled}
          onValueChange={change}
        />
      )}
    </>
  );
}
