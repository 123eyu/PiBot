import type { ModelInfo, Provider, Settings } from "@pibot/models-contract/full";
import {
  layoutStyles,
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

const FOLLOW = "follow";
export function AuxiliaryModelSettings({
  models,
  providers,
  task,
  disabled,
  pickerId,
  health,
}: {
  pickerId: string;
  health?: ComponentProps<typeof ModelHealthNotice>["reason"];
  models: ModelInfo[];
  providers: Provider[];
  task: Task;
  disabled: boolean;
}) {
  const { t, settings } = useSettings();
  const { peer } = useRpc();
  const lifetime = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement peer owns a new UI lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [peer]);
  const configured = settings?.auxiliaryModel;
  const selected = models.find(
    (m) => m.provider === configured?.provider && m.id === configured.id,
  );
  const available = useModelOptions(models, providers, true);
  const text = useComboboxText();
  const value = configured ? JSON.stringify([configured.provider, configured.id]) : FOLLOW;
  const options = [
    { value: FOLLOW, label: t("models.auxiliaryFollow") },
    ...(configured && !selected
      ? [
          {
            value,
            label: t("workspace.modelUnavailable", { model: configured.id }),
            disabled: true,
          },
        ]
      : []),
    ...available,
  ];
  const save = (auxiliaryModel: Settings["auxiliaryModel"]) => {
    const controller = lifetime.current;
    void task.run(async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      // Peer cancellation retires the local wait; settings writes still use the unified RPC.
      await requirePeer(peer).call("settings.set", { auxiliaryModel }, { signal });
      if (!controller.signal.aborted) task.setSuccess(t("models.auxiliarySaved"));
    });
  };
  return (
    <SettingsSection title={t("models.auxiliaryModel")}>
      <SettingsRow
        icon="star"
        tone="amber"
        label={t("models.auxiliaryModel")}
        note={t("models.auxiliaryNote")}
      >
        <div className={layoutStyles.select}>
          <Combobox
            id={pickerId}
            popupMinWidth={380}
            {...text}
            hideLabel
            label={t("models.auxiliaryModel")}
            placeholder={t("models.auxiliaryFollow")}
            options={options}
            value={value}
            disabled={disabled || task.busy || !peer || !settings}
            onValueChange={(value) => {
              if (value === FOLLOW) save(null);
              else {
                const model = models.find((m) => JSON.stringify([m.provider, m.id]) === value);
                if (model) save({ provider: model.provider, id: model.id });
              }
            }}
          />
        </div>
      </SettingsRow>
      {health && (
        <SettingsLine tone="danger">
          <ModelHealthNotice reason={health} pickerId={pickerId} />
        </SettingsLine>
      )}
      {configured && !selected && <SettingsLine>{t("models.auxiliaryUnavailable")}</SettingsLine>}
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
  );
}
