import { useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { z } from "zod";
import { useSharedText, useText } from "../../runtime/context.tsx";
import { IconDot } from "../../theme/icon-dot.tsx";
import { PageTint } from "../../theme/page-tint.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Button, EmptyState } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { botLook } from "../conversations/model.ts";
import { ConnectorsPage, PermissionsPage } from "./bot/PermissionPages.tsx";
import { AvatarPage, ModelPage, PersonaPage } from "./bot/ProfilePages.tsx";
import { MemoryPage, RoutinesPage, SkillPage, SkillsPage } from "./bot/ResourcePages.tsx";
import { Group, LinkRow, Rows, SettingsPage, TextField } from "./fields.tsx";
import { type BotSettingsState, useBotSettings } from "./use-bot-settings.ts";

const ParamsSchema = z.object({
  id: z.uuid(),
  page: z
    .enum([
      "avatar",
      "persona",
      "model",
      "memory",
      "skills",
      "skill",
      "routines",
      "permissions",
      "connectors",
    ])
    .optional(),
  item: z.uuid().optional(),
});
export type BotPage = NonNullable<z.infer<typeof ParamsSchema>["page"]>;
/** Route: /settings/bot/<id>[?page=…]; every page reads the same Bot through its own hook. */
export function BotSettingsScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params.success)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="message" title={t("stale")} />
      </View>
    );
  const { id, page, item } = params.data;
  return <BotSettingsView key={`${id}:${page}:${item}`} botId={id} page={page} item={item} />;
}
function BotSettingsView({ botId, page, item }: { botId: string; page?: BotPage; item?: string }) {
  const state = useBotSettings(botId, page);
  const router = useRouter();
  const open = (next: BotPage, itemId?: string) =>
    router.push(`/settings/bot/${botId}?page=${next}${itemId ? `&item=${itemId}` : ""}`);
  // Every page of a Bot's settings carries its avatar colour.
  return (
    <PageTint name={state.bot?.avatarColor}>
      <BotPageBody state={state} page={page} item={item} open={open} />
    </PageTint>
  );
}
function BotPageBody({
  state,
  page,
  item,
  open,
}: {
  state: BotSettingsState;
  page?: BotPage;
  item?: string;
  open: (next: BotPage, itemId?: string) => void;
}) {
  switch (page) {
    case "avatar":
      return <AvatarPage state={state} />;
    case "persona":
      return <PersonaPage state={state} />;
    case "model":
      return <ModelPage state={state} />;
    case "memory":
      return <MemoryPage state={state} />;
    case "skills":
      return <SkillsPage state={state} open={(skillId) => open("skill", skillId)} />;
    case "skill":
      return <SkillPage state={state} skillId={item} />;
    case "routines":
      return <RoutinesPage state={state} />;
    case "permissions":
      return <PermissionsPage state={state} />;
    case "connectors":
      return <ConnectorsPage state={state} />;
    default:
      return <BotOverview state={state} open={open} />;
  }
}
/** Desktop Bot panel header: 72pt avatar, name, what it does, and two pill actions. */
function ProfileHead({ state, onAvatar }: { state: BotSettingsState; onAvatar: () => void }) {
  const t = useText(),
    colors = useColors(),
    router = useRouter();
  const bot = state.bot;
  if (!bot) return null;
  return (
    <View
      style={{
        alignItems: "center",
        gap: 6,
        paddingTop: 18,
        paddingHorizontal: 24,
        paddingBottom: 6,
      }}
    >
      <BotAvatar bot={botLook(bot)} size={72} />
      <Text
        style={{
          marginTop: 6,
          fontSize: 18,
          lineHeight: 24,
          fontWeight: "600",
          color: colors.text,
        }}
      >
        {bot.name}
      </Text>
      {!!bot.description && (
        <Text
          numberOfLines={2}
          style={{ fontSize: 13, lineHeight: 19, color: colors.text2, textAlign: "center" }}
        >
          {bot.description}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <Button
          icon="message"
          title={t("sendMessage")}
          onPress={() => router.push(`/conversation/bot/${bot.id}`)}
        />
        <Button
          icon="edit"
          title={t("changeAvatar")}
          disabled={!state.editable}
          onPress={onAvatar}
        />
      </View>
    </View>
  );
}
function BotOverview({ state, open }: { state: BotSettingsState; open: (page: BotPage) => void }) {
  const t = useText(),
    shared = useSharedText();
  const { bot, data } = state;
  const model = data?.models?.find(
    (m) => m.provider === bot?.modelProvider && m.id === bot?.modelId,
  );
  const skills = data?.skills;
  return (
    <SettingsPage
      title={bot?.name ?? t("botSettings")}
      state={state}
      footer={t("settingsDesktopOnly")}
    >
      {bot && (
        <>
          <ProfileHead state={state} onAvatar={() => open("avatar")} />
          <Group title={t("sectionProfile")}>
            <Rows>
              {[
                <TextField
                  key="name"
                  label={t("botName")}
                  value={bot.name}
                  maxLength={200}
                  editable={state.editable}
                  onSave={(name) => (name.trim() ? state.update({ name: name.trim() }) : undefined)}
                />,
                <TextField
                  key="description"
                  label={t("botDescription")}
                  value={bot.description ?? ""}
                  placeholder={t("descriptionPlaceholder")}
                  maxLength={4000}
                  multiline
                  editable={state.editable}
                  onSave={(description) => state.update({ description })}
                />,
                <LinkRow
                  key="avatar"
                  lead={<IconDot icon="palette" tint="pink" />}
                  title={t("avatar")}
                  onPress={() => open("avatar")}
                />,
              ]}
            </Rows>
          </Group>
          <Group title={t("persona")}>
            <LinkRow
              lead={<IconDot icon="file" tint="violet" />}
              title={t("persona")}
              subtitle={t("personaHint")}
              onPress={() => open("persona")}
            />
          </Group>
          {bot.category !== "image" && (
            <Group title={t("model")}>
              <LinkRow
                lead={<IconDot icon="rocket" tint="teal" />}
                title={t("model")}
                value={
                  model
                    ? `${model.name} · ${shared(`models.thinking.${bot.thinkingLevel}`)}`
                    : (bot.modelId ?? t("modelNone"))
                }
                onPress={() => open("model")}
              />
            </Group>
          )}
          <Group title={t("memory")}>
            <LinkRow
              lead={<IconDot icon="clock" tint="amber" />}
              title={t("memory")}
              subtitle={t(bot.memoryMode === "ask" ? "memoryAsk" : "memoryAuto")}
              value={t("memoryCount", { count: data?.profile.memories.length ?? 0 })}
              onPress={() => open("memory")}
            />
          </Group>
          <Group title={t("sectionSkillsRoutines")}>
            <Rows>
              {[
                <LinkRow
                  key="skills"
                  lead={<IconDot icon="puzzle" tint="orange" />}
                  title={t("skills")}
                  value={
                    skills
                      ? t("skillsCount", {
                          enabled: skills.filter((s) => s.enabled).length,
                          total: skills.length,
                        })
                      : undefined
                  }
                  onPress={() => open("skills")}
                />,
                <LinkRow
                  key="routines"
                  lead={<IconDot icon="play" tint="blue" />}
                  title={t("routines")}
                  value={
                    data?.routines ? t("routinesCount", { count: data.routines.length }) : undefined
                  }
                  onPress={() => open("routines")}
                />,
              ]}
            </Rows>
          </Group>
          <Group title={t("sectionPermsConnectors")}>
            <Rows>
              {[
                <LinkRow
                  key="permissions"
                  lead={<IconDot icon="key" tint="gray" />}
                  title={t("permissions")}
                  subtitle={t("permissionsHint")}
                  onPress={() => open("permissions")}
                />,
                bot.category !== "image" && (
                  <LinkRow
                    key="connectors"
                    lead={<IconDot icon="link" tint="teal" />}
                    title={t("connectors")}
                    subtitle={t("connectorsHint")}
                    onPress={() => open("connectors")}
                  />
                ),
              ]}
            </Rows>
          </Group>
        </>
      )}
    </SettingsPage>
  );
}
