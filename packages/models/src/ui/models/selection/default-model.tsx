import type { Bot, ModelInfo, Provider, Settings } from "@pibot/models-contract/full";
import {
  layoutStyles,
  normalizedThinking,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useComboboxText,
  useModelOptions,
  useRpc,
  useSettings,
} from "@pibot/renderer-kit";
import { Combobox } from "@pibot/ui";
import { type ComponentProps, useEffect, useRef } from "react";
import { requirePeer } from "../../setup/operations.ts";
import type { Task } from "../providers/provider-form.tsx";
import { ModelHealthNotice } from "./model-health.tsx";

async function wait<T>(pending: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * The default model appears once, here. Per-Bot models are changed only in each Bot's
 * profile, so the old "change the current Bot's model" shortcut is gone.
 */
export function DefaultModelSettings({
  models,
  providers,
  task,
  disabled,
  target,
  pickerId,
  health,
}: {
  pickerId: string;
  health?: ComponentProps<typeof ModelHealthNotice>["reason"];
  models: ModelInfo[];
  providers: Provider[];
  task: Task;
  disabled: boolean;
  target?: "pi-model";
}) {
  const { t, settings, language } = useSettings();
  const { peer } = useRpc();
  const section = useRef<HTMLDivElement>(null);
  const lifetime = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement peer owns a new UI lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [peer]);
  const defaults = settings?.defaultModel;
  const preference =
    defaults?.thinkingPreference === undefined
      ? (defaults?.thinkingLevel ?? null)
      : defaults.thinkingPreference;
  const selected = models.find((m) => m.provider === defaults?.provider && m.id === defaults.id);
  const availableOptions = useModelOptions(models, providers, true);
  const value = defaults ? JSON.stringify([defaults.provider, defaults.id]) : "";
  const options =
    defaults && !selected
      ? [
          { value, label: t("workspace.modelUnavailable", { model: defaults.id }), disabled: true },
          ...availableOptions,
        ]
      : availableOptions;
  const comboboxText = useComboboxText();
  const levels: readonly Bot["thinkingLevel"][] = selected?.reasoning
    ? (selected.thinkingLevels ?? ["off", "low", "medium", "high"])
    : ["off"];
  const thinking = selected ? normalizedThinking(selected, preference) : "off";
  useEffect(() => {
    if (!target) return;
    const element = section.current;
    const scroller = element?.closest<HTMLElement>("[data-settings-scroll]");
    if (element && scroller) {
      scroller.scrollTop +=
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      element.focus({ preventScroll: true });
    }
  }, [target]);
  const save = (defaultModel: NonNullable<Settings["defaultModel"]>) => {
    const controller = lifetime.current;
    void task.run(async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      signal.throwIfAborted();
      await wait(requirePeer(peer).call("settings.set", { defaultModel }), signal);
      if (!controller.signal.aborted) task.setSuccess(t("setup.modelSaved"));
    });
  };
  // A model without a known context size shows no context line at all (no "context:  tokens").
  const facts = selected
    ? [
        selected.contextWindow > 0 &&
          t("models.contextShort", {
            count: new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en", {
              notation: "compact",
            }).format(selected.contextWindow),
          }),
        selected.input.includes("image") && t("models.images"),
      ].filter(Boolean)
    : [];
  const locked = disabled || task.busy || !peer || !settings;
  return (
    <div ref={section} tabIndex={-1} className={layoutStyles.section}>
      <SettingsSection title={t("models.defaultModel")}>
        <SettingsRow
          icon="key"
          tone="violet"
          label={t("models.defaultModel")}
          note={t("models.defaultNote")}
        >
          <div className={layoutStyles.select}>
            <Combobox
              id={pickerId}
              popupMinWidth={380}
              {...comboboxText}
              hideLabel
              label={t("models.defaultModel")}
              placeholder={t("setup.chooseModel")}
              options={options}
              value={value}
              disabled={locked || (!models.length && !health)}
              onValueChange={(value) => {
                const model = models.find((m) => JSON.stringify([m.provider, m.id]) === value);
                if (model)
                  save({
                    provider: model.provider,
                    id: model.id,
                    thinkingPreference: preference,
                    thinkingLevel: normalizedThinking(model, preference),
                  });
              }}
            />
          </div>
        </SettingsRow>
        {health && (
          <SettingsLine tone="danger">
            <ModelHealthNotice reason={health} pickerId={pickerId} />
          </SettingsLine>
        )}
        <SettingsRow
          icon="star"
          tone="amber"
          label={t("models.thinking")}
          note={facts.join(" · ") || undefined}
        >
          <div className={layoutStyles.selectSmall}>
            <Combobox
              {...comboboxText}
              hideLabel
              label={t("models.thinking")}
              placeholder={t("models.thinking")}
              options={levels.map((value) => ({ value, label: t(`models.thinking.${value}`) }))}
              value={thinking}
              disabled={locked || !selected?.reasoning}
              onValueChange={(level) => {
                if (selected && levels.includes(level as Bot["thinkingLevel"]))
                  save({
                    provider: selected.provider,
                    id: selected.id,
                    thinkingLevel: level as Bot["thinkingLevel"],
                    thinkingPreference: level as Bot["thinkingLevel"],
                  });
              }}
            />
          </div>
        </SettingsRow>
        {!models.length && <SettingsLine>{t("models.noConfigured")}</SettingsLine>}
        {task.error && (
          <SettingsLine role="alert" tone="danger" dot="danger">
            {task.error}
          </SettingsLine>
        )}
        {task.success && (
          <SettingsLine role="status" dot="ok">
            {task.success}
          </SettingsLine>
        )}
      </SettingsSection>
    </div>
  );
}
