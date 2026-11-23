import type { Bot, ModelInfo } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { usedOfflineModels } from "../../../offline/engine.ts";
import { useOffline, useOfflineEngine } from "../../../offline/OfflineProvider.tsx";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { radius } from "../../../theme/scale.ts";
import { avatarColor, useColors } from "../../../theme/use-theme.ts";
import { BotAvatar } from "../../../ui/avatar.tsx";
import { Button, Segmented, Separator } from "../../../ui/controls.tsx";
import { LeaveGuard } from "../../../ui/leave-guard.tsx";
import { OptionRow, Radio } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import { botLook } from "../../conversations/model.ts";
import { avatarColors, avatarEyes, avatarShapes } from "../avatar-presets.ts";
import type { BotPatch } from "../calls.ts";
import { DraftArea, Group, Note, SettingsPage } from "../fields.tsx";
import type { BotSettingsState } from "../use-bot-settings.ts";

type Props = { state: BotSettingsState };

export function AvatarPage({ state }: Props) {
  const t = useText(),
    colors = useColors();
  const bot = state.bot;
  const pick = (field: keyof typeof lookKey, value: string, selected: boolean) => {
    if (!selected) void state.update({ [field]: value } as BotPatch);
  };
  // Shapes and eyes are previewed on the Bot itself in a six-column grid; colours are swatches.
  const grid = (field: "avatarShape" | "avatarEyes", title: string, options: readonly string[]) =>
    bot && (
      <Group title={title}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            paddingVertical: 12,
            paddingHorizontal: 10,
          }}
        >
          {options.map((value, index) => {
            const selected = bot[field] === value;
            return (
              <View
                key={value}
                style={{ width: field === "avatarEyes" ? "20%" : "16.66%", padding: 3 }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title} ${index + 1}`}
                  accessibilityState={{ selected, disabled: !state.editable }}
                  disabled={!state.editable}
                  onPress={() => pick(field, value, selected)}
                  style={{
                    aspectRatio: 1,
                    borderRadius: radius.row,
                    borderWidth: 1,
                    borderColor: selected ? colors.text : "transparent",
                    backgroundColor: selected ? colors.hover : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: state.editable ? 1 : 0.5,
                  }}
                >
                  <BotAvatar bot={{ ...botLook(bot), [lookKey[field]]: value }} size={36} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </Group>
    );
  return (
    <SettingsPage title={t("avatar")} state={state} footer={t("avatarImageNote")}>
      {bot && (
        <>
          <View style={{ alignItems: "center", paddingTop: 20, paddingBottom: 6 }}>
            <BotAvatar bot={botLook(bot)} size={96} />
          </View>
          {grid("avatarShape", t("avatarShape"), avatarShapes)}
          <Group title={t("avatarColor")}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 14 }}>
              {avatarColors.map((value, index) => {
                const selected = bot.avatarColor === value;
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("avatarColor")} ${index + 1}`}
                    accessibilityState={{ selected, disabled: !state.editable }}
                    disabled={!state.editable}
                    hitSlop={6}
                    onPress={() => pick("avatarColor", value, selected)}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      padding: 2,
                      borderWidth: 2,
                      borderColor: selected ? colors.text : "transparent",
                      opacity: state.editable ? 1 : 0.5,
                    }}
                  >
                    <View
                      style={{
                        flex: 1,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: colors.b2,
                        backgroundColor: avatarColor(colors, value),
                      }}
                    />
                  </Pressable>
                );
              })}
            </View>
          </Group>
          {grid("avatarEyes", t("avatarEyes"), avatarEyes)}
        </>
      )}
    </SettingsPage>
  );
}
const lookKey = { avatarShape: "shape", avatarColor: "color", avatarEyes: "eyes" } as const;

/** Persona and norms are edited as drafts and saved together; norms carry `expectedNorms`. */
export function PersonaPage({ state }: Props) {
  const t = useText(),
    toast = useToast();
  const bot = state.bot;
  // Undefined drafts follow the computer's values, so a change made there shows until typing.
  const [persona, setPersona] = useState<string>();
  const [norms, setNorms] = useState<string>();
  const [expectedNorms, setExpectedNorms] = useState<string>();
  const personaValue = persona ?? bot?.systemPrompt ?? "";
  const normsValue = norms ?? bot?.norms ?? "";
  const changed = !!bot && (personaValue !== bot.systemPrompt || normsValue !== (bot.norms ?? ""));
  const reset = () => {
    setPersona(undefined);
    setNorms(undefined);
    setExpectedNorms(undefined);
  };
  const save = async () => {
    if (!bot) return;
    const result = await state.update(
      {
        ...(personaValue !== bot.systemPrompt ? { systemPrompt: personaValue } : {}),
        ...(normsValue !== (bot.norms ?? "")
          ? { norms: normsValue, expectedNorms: expectedNorms ?? bot.norms ?? "" }
          : {}),
      },
      // Norms replaced on the computer meanwhile: show its values instead of overwriting them.
      reset,
    );
    if (result) {
      reset();
      toast(t("settingsSaved"));
    }
  };
  return (
    <SettingsPage title={t("persona")} state={state}>
      {bot && (
        <>
          <View style={{ paddingTop: 12, paddingHorizontal: 16, gap: 14 }}>
            {[
              <DraftArea
                key="persona"
                label={t("personaLabel")}
                value={personaValue}
                placeholder={t("personaPlaceholder")}
                maxLength={100000}
                editable={state.editable}
                onChange={setPersona}
              />,
              <DraftArea
                key="norms"
                label={t("normsLabel")}
                value={normsValue}
                placeholder={t("normsPlaceholder")}
                maxLength={20000}
                minHeight={120}
                editable={state.editable}
                onChange={(next) => {
                  if (norms === undefined) setExpectedNorms(bot.norms ?? "");
                  setNorms(next);
                }}
              />,
            ]}
          </View>
          <View style={{ padding: 16 }}>
            <Button
              size="lg"
              variant="prim"
              title={t("save")}
              disabled={!state.editable || !changed}
              onPress={() => void save()}
            />
          </View>
          <LeaveGuard
            dirty={state.editable && changed}
            title={t("settingsLeaveTitle")}
            text={t("settingsLeaveText")}
          />
        </>
      )}
    </SettingsPage>
  );
}

type ThinkingLevel = Bot["thinkingLevel"];
const allLevels: ThinkingLevel[] = ["off", "low", "medium", "high"];
const levelsOf = (model?: ModelInfo): ThinkingLevel[] =>
  !model?.reasoning ? ["off"] : (model.thinkingLevels ?? allLevels);
export function ModelPage({ state }: Props) {
  const t = useText(),
    shared = useSharedText();
  const bot = state.bot,
    models = state.data?.models ?? [];
  const offline = useOffline();
  const offlineEngine = useOfflineEngine();
  const offlineMode =
    offline.unreachable && !!bot && offline.manifest?.bots.some((row) => row.id === bot.id);
  // The models the Bots use, not a router provider's whole catalog.
  const offlineModels = offlineMode ? usedOfflineModels(offline.manifest) : [];
  const conflict = !!bot && offline.conflicts.includes(bot.id);
  useEffect(() => {
    if (!conflict || !bot) return;
    const timer = setTimeout(() => offlineEngine.clearConflict(bot.id), 5000);
    return () => clearTimeout(timer);
  }, [conflict, bot, offlineEngine]);
  const current = models.find((m) => m.provider === bot?.modelProvider && m.id === bot?.modelId);
  return (
    <SettingsPage title={t("model")} state={state} footer={t("modelNote")}>
      {bot && (
        <>
          {conflict && <Note text={t("computerModelUpdated")} />}
          <Group title={t("model")}>
            {offlineMode ? (
              offlineModels.map((model, index) => {
                const selected =
                  model.modelId ===
                  offline.manifest?.bots.find((row) => row.id === bot?.id)?.modelId;
                return (
                  <View key={`${model.providerId}/${model.modelId}`}>
                    {(index === 0 || offlineModels[index - 1]?.providerId !== model.providerId) && (
                      <Note text={model.providerName} />
                    )}
                    {index > 0 && <Separator />}
                    <OptionRow
                      title={model.modelName}
                      subtitle={model.providerName}
                      selected={selected}
                      disabled={!state.editable && !offlineMode}
                      right={<Radio on={selected} />}
                      onPress={() => {
                        if (!selected && bot)
                          void offlineEngine.selectModel(bot.id, model.providerId, model.modelId);
                      }}
                    />
                  </View>
                );
              })
            ) : models.length ? (
              models.map((model, index) => {
                const selected = model === current;
                return (
                  <View key={`${model.provider}/${model.id}`}>
                    {index > 0 && <Separator />}
                    <OptionRow
                      title={model.name}
                      subtitle={model.provider}
                      selected={selected}
                      disabled={!state.editable && !offlineMode}
                      right={<Radio on={selected} />}
                      // The computer normalizes the thinking level for the new model.
                      onPress={() => {
                        if (!selected)
                          void state.update({ modelProvider: model.provider, modelId: model.id });
                      }}
                    />
                  </View>
                );
              })
            ) : (
              <Note text={t("noModels")} />
            )}
          </Group>
          {current && (
            <Group title={t("thinking")}>
              <View style={{ padding: 12 }}>
                <Segmented
                  options={levelsOf(current).map((level) => ({
                    value: level,
                    label: shared(`models.thinking.${level}`),
                  }))}
                  value={bot.thinkingLevel}
                  disabled={!state.editable}
                  onChange={(level) => void state.update({ thinkingLevel: level })}
                />
              </View>
            </Group>
          )}
        </>
      )}
    </SettingsPage>
  );
}
