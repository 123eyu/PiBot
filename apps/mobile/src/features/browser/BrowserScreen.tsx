import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { z } from "zod";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, Button, EmptyState, ErrorLine } from "../../ui/controls.tsx";
import { IconButton, NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useToast } from "../../ui/toast.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import { BrowserFrame } from "./BrowserFrame.tsx";
import { BrowserInputBar } from "./BrowserInputBar.tsx";
import { type BotBrowserView, useBotBrowser } from "./use-bot-browser.ts";

const ParamsSchema = z.object({ botId: z.uuid(), topic: z.uuid().optional() });
/** The computer's Bot browser on the phone; the phone itself opens no web page. */
export function BrowserScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params.success)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title={t("browserTitle")} onBack={() => router.back()} />
        <EmptyState icon="globe" title={t("stale")} />
      </View>
    );
  return (
    <BrowserView key={params.data.botId} botId={params.data.botId} topic={params.data.topic} />
  );
}

/**
 * The browser pane's address row: a `tert` pill while watching; once taken over, back /
 * forward / reload and an editable field, as in the desktop takeover toolbar.
 */
function AddressBar({ browser }: { browser: BotBrowserView }) {
  const colors = useColors(),
    t = useText();
  const [draft, setDraft] = useState<string>();
  const editable = browser.takenOver && !browser.action.busy;
  // A new page replaces whatever was typed but not sent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new address resets the draft.
  useEffect(() => setDraft(undefined), [browser.address]);
  const value = draft ?? browser.address;
  const submit = async () => {
    const url = (draft ?? "").trim();
    if (!url) return;
    if ((await browser.go("url", url)) !== undefined) setDraft(undefined);
  };
  const tool = (
    icon: "back" | "chevronRight" | "refresh",
    label: string,
    go: "back" | "forward" | "reload",
  ) => (
    <IconButton
      icon={icon}
      size={icon === "refresh" ? 18 : 20}
      label={label}
      disabled={!editable}
      onPress={() => void browser.go(go)}
    />
  );
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingTop: 6,
        paddingBottom: 8,
        paddingHorizontal: browser.takenOver ? 6 : 12,
      }}
    >
      {browser.takenOver && (
        <>
          {tool("back", t("browserBack"), "back")}
          {tool("chevronRight", t("browserForward"), "forward")}
          {tool("refresh", t("browserReload"), "reload")}
        </>
      )}
      <View
        style={{
          flex: 1,
          height: 36,
          borderRadius: 18,
          paddingLeft: 12,
          paddingRight: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: editable ? colors.card : colors.tert,
          borderWidth: editable ? 1 : 0,
          borderColor: colors.b2,
        }}
      >
        {!editable && (
          <Icon name={browser.loading ? "clock" : "lock"} color={colors.text2} size={13} />
        )}
        <TextInput
          value={value}
          onChangeText={setDraft}
          editable={editable}
          placeholder={browser.state?.open ? t("browserNoPage") : t("browserAddress")}
          placeholderTextColor={colors.text2}
          accessibilityLabel={t("browserAddress")}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          maxLength={2048}
          onSubmitEditing={() => void submit()}
          style={{
            flex: 1,
            color: editable ? colors.text : colors.text2,
            fontSize: editable ? 15 : 13,
            paddingVertical: 0,
          }}
        />
      </View>
      {draft !== undefined && editable && (
        <Button variant="prim" title={t("browserGo")} onPress={() => void submit()} />
      )}
    </View>
  );
}

function BrowserView({ botId, topic }: { botId: string; topic?: string }) {
  const router = useRouter(),
    colors = useColors(),
    t = useText(),
    toast = useToast(),
    insets = useSafeAreaInsets(),
    conversations = useConversations();
  const browser = useBotBrowser({ botId }, topic);
  const owner = conversations.find("bot", botId);
  const name = owner?.name ?? "";
  const { state, frame, takenOver } = browser;
  const controls = takenOver && !browser.action.busy;
  const notice = !browser.online
    ? t("offline")
    : browser.elsewhere
      ? t("browserTakenElsewhere")
      : takenOver
        ? t("browserTakenOver")
        : state?.sleeping
          ? t("browserSleeping")
          : t("browserWatching");
  const takeOver = async () => {
    if (await browser.takeOver()) toast(t("browserTakeoverDone"));
  };
  const handBack = async () => {
    if (await browser.handBack()) toast(t("browserHandedBack"));
  };
  const canTake = browser.online && !browser.elsewhere && !!(state?.open || state?.sleeping);
  const error = browser.action.error ?? browser.input.error;
  const action = takenOver ? (
    <Button
      size="lg"
      variant="prim"
      title={t("browserHandBack")}
      disabled={browser.action.busy}
      onPress={() => void handBack()}
    />
  ) : (
    <Button
      size="lg"
      variant="prim"
      icon="hand"
      title={t("browserTakeover")}
      disabled={!canTake || browser.action.busy}
      onPress={() => void takeOver()}
    />
  );
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
      <NavBar
        title={t("browserTitle")}
        subtitle={name}
        tint={owner?.looks[0]?.color}
        onBack={() => router.back()}
      />
      {(takenOver || browser.elsewhere) && (
        <View style={{ marginTop: 8, marginHorizontal: 12 }}>
          <Banner tone="warn" icon="hand" text={notice} />
        </View>
      )}
      <AddressBar browser={browser} />
      <ErrorLine text={error && t(error)} />
      <View style={{ flex: 1, paddingHorizontal: 12 }}>
        {frame && (state?.open ?? true) ? (
          <BrowserFrame
            frame={frame}
            interactive={controls}
            onTap={(x, y) => void browser.tap(x, y)}
            onScroll={(x, y, dx, dy) => void browser.scroll(x, y, dx, dy)}
          />
        ) : state && !state.open ? (
          <EmptyState icon="globe" title={t("browserClosed")} hint={t("browserClosedHint")} />
        ) : (
          <EmptyState
            icon="globe"
            title={browser.online ? t("browserWaiting") : t("offline")}
            hint={browser.streamError ? t("failed") : undefined}
          />
        )}
      </View>
      {frame && (
        <Text
          style={{
            textAlign: "center",
            fontSize: 12,
            lineHeight: 18,
            color: colors.text2,
            paddingTop: 8,
            paddingHorizontal: 28,
          }}
        >
          {t("browserFrameInfo", { width: frame.width, height: frame.height })}
        </Text>
      )}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingTop: 10,
          paddingHorizontal: 16,
          paddingBottom: takenOver ? 4 : Math.max(insets.bottom, 8),
        }}
      >
        <Text style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: colors.text2 }}>
          {takenOver ? t("browserAutoHandBack") : browser.elsewhere ? t("browserWatching") : notice}
        </Text>
        {action}
      </View>
      {takenOver && <BrowserInputBar browser={browser} />}
    </KeyboardAvoidingView>
  );
}
