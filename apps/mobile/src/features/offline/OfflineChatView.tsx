import type { Message } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { type ComponentRef, type RefObject, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useOffline, useOfflineEngine } from "../../offline/OfflineProvider.tsx";
import type { LocalMessage } from "../../offline/store.ts";
import { useText } from "../../runtime/context.tsx";
import { PageTint } from "../../theme/page-tint.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Banner, Button, ErrorLine, FootNote } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { LeaveGuard } from "../../ui/leave-guard.tsx";
import { useToast } from "../../ui/toast.tsx";
import { Composer } from "../chat/Composer.tsx";
import { MessageItem } from "../chat/messages/MessageItem.tsx";
import { OfflineDetailsSheet } from "./OfflineDetailsSheet.tsx";
import { OfflineDivider, OfflineHistory, useCachedHistory } from "./OfflineHistory.tsx";
import { RunnerExecutionView } from "./RunnerExecutionView.tsx";

/** A local message drawn with the ordinary chat bubble (the desktop's message shape). */
function shown(message: LocalMessage, topicId: string, botId: string): Message {
  return {
    id: message.clientId,
    conversationId: topicId,
    botId: message.role === "assistant" ? botId : null,
    role: message.role,
    content: message.content,
    status: message.status,
    runId: null,
    // The desktop's network text blames the computer's network; offline it is the phone's own.
    errorCode:
      message.errorCode && message.errorCode !== "network"
        ? (message.errorCode as Message["errorCode"])
        : null,
    usage: null,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

/**
 * In v0.0.2, asked to use a runner, the offline Bot gave no reason (or a wrong one) and the page
 * said only that runners need a synced folder. What this Bot's synced snapshot allows is shown
 * here, so the reason does not depend on how the phone's model words it. `null`: no runner.
 */
function useSnapshotRunner(botId: string) {
  const offline = useOffline(),
    engine = useOfflineEngine();
  const [runner, setRunner] = useState<{ name: string; folder: string } | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision marks a new sync.
  useEffect(() => {
    const computerId = offline.computerId;
    if (!computerId) return;
    let live = true;
    void engine.store
      .snapshot(computerId, botId)
      .then((snapshot) => {
        const context = snapshot?.runner;
        if (live)
          setRunner(
            context?.tools.length
              ? { name: context.name, folder: context.boundary.primaryPath }
              : null,
          );
      })
      // An unreadable copy means no runner tools for this reply either.
      .catch(() => live && setRunner(null));
    return () => {
      live = false;
    };
  }, [engine, offline.computerId, botId, offline.revision]);
  return runner;
}

/**
 * A private chat while the computer is unreachable and this Bot is ready on the
 * phone. It shows the phone's own offline topic, streams the local reply, and says plainly which
 * capabilities wait for the computer. Groups never come here (they keep the outbox, 待决定 1).
 */
export function OfflineChatView({
  botId,
  topic: opened,
  draft,
}: {
  botId: string;
  topic?: string;
  /** Shared with the computer's chat view, so a switch between them keeps the typed text. */
  draft?: RefObject<string>;
}) {
  const offline = useOffline(),
    engine = useOfflineEngine(),
    colors = useColors(),
    t = useText(),
    toast = useToast(),
    router = useRouter();
  const [text, setText] = useState(() => draft?.current ?? "");
  useEffect(() => {
    if (draft) draft.current = text;
  }, [text, draft]);
  const [failed, setFailed] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Maintainers 2026-11-14: a Bot with a long chat opened empty offline. What the phone already has
  // stays above the offline topic, so the thread is hidden until it sits at its end, as online.
  const history = useCachedHistory(offline.computerId, botId, opened);
  const [positioned, setPositioned] = useState(false);
  const hidden = !history.ready || (history.messages.length > 0 && !positioned);
  const runner = useSnapshotRunner(botId);
  const [details, setDetails] = useState(false);
  const bot = offline.manifest?.bots.find((entry) => entry.id === botId);
  const topic = offline.topics[botId];
  const live = offline.live?.botId === botId ? offline.live : undefined;
  const look = bot
    ? { name: bot.name, shape: bot.avatarShape, color: bot.avatarColor, eyes: bot.avatarEyes }
    : undefined;
  const send = async (value: string) => {
    const message = value.trim();
    if (!message || live) return;
    setFailed(false);
    setText("");
    try {
      await engine.send(botId, message);
    } catch {
      setText(message);
      setFailed(true);
    }
  };
  const messages = topic?.messages ?? [];
  const pendingQuestion = !live ? messages.at(-1)?.question : undefined;
  return (
    // The Bot's colour, as in its online chat (wash, composer, send).
    <PageTint name={look?.color}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
        <NavBar
          title={bot?.name ?? ""}
          subtitle={t("offlineSubtitle")}
          lead={look && <BotAvatar bot={look} size={32} state={live ? "working" : "idle"} />}
          onBack={() => router.back()}
        />
        <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 6 }}>
          <Banner
            tone="warn"
            icon="warning"
            singleLine
            text={t("offlineLinePhoneOnly")}
            action={{ title: t("offlineHintOpen"), onPress: () => setDetails(true) }}
          />
        </View>
        <OfflineDetailsSheet
          visible={details}
          can={`${t("offlineNewTopic")} ${t("offlineHistoryUnseen")}`}
          wait={t("offlineUnavailable")}
          runner={
            runner
              ? t("offlineRunnerReady", { name: runner.name, folder: runner.folder })
              : runner === null
                ? t("offlineRunnerNone")
                : undefined
          }
          onClose={() => setDetails(false)}
        />
        <ErrorLine text={failed ? t("offlineSendFailed") : undefined} />
        <ScrollView
          ref={scroll}
          style={{ flex: 1, opacity: hidden ? 0 : 1 }}
          contentContainerStyle={{ padding: 12, gap: 14 }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            scroll.current?.scrollToEnd({ animated: false });
            // Android may report the size before the view's own layout; reveal a frame later.
            if (history.ready && !positioned)
              requestAnimationFrame(() => {
                scroll.current?.scrollToEnd({ animated: false });
                setPositioned(true);
              });
          }}
        >
          <OfflineHistory
            messages={history.messages}
            look={look}
            userColor={bot?.avatarColor ?? "violet"}
          />
          {!history.messages.length && <OfflineDivider text={t("offlineHistoryDivider")} />}
          {messages.map((message) => (
            <View key={message.clientId} style={{ gap: 6 }}>
              <MessageItem
                message={shown(message, topic?.id ?? "", botId)}
                look={look}
                userColor={bot?.avatarColor ?? "violet"}
                onPress={() => undefined}
              />
              {message.errorCode === "network" && <FootNote text={t("offlineFailNetwork")} />}
            </View>
          ))}
          <RunnerExecutionView botId={botId} />
          {/* Replies already finished in this run read as their own messages. */}
          {live?.parts?.map((part, index) => (
            <MessageItem
              // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow at the end during a run.
              key={`${live.clientId}:${index}`}
              message={shown(
                {
                  clientId: `${live.clientId}:${index}`,
                  role: "assistant",
                  content: part,
                  status: "done",
                  createdAt: new Date().toISOString(),
                },
                live.topicId,
                botId,
              )}
              look={look}
              userColor={bot?.avatarColor ?? "violet"}
              onPress={() => undefined}
            />
          ))}
          {live && (
            <MessageItem
              message={{
                ...shown(
                  {
                    clientId: live.clientId,
                    role: "assistant",
                    content: live.text,
                    status: "done",
                    createdAt: new Date().toISOString(),
                  },
                  live.topicId,
                  botId,
                ),
                status: "streaming",
              }}
              look={look}
              userColor={bot?.avatarColor ?? "violet"}
              onPress={() => undefined}
            />
          )}
          {pendingQuestion && (
            <View style={{ gap: 8 }}>
              <FootNote text={`${t("offlineChoose")}: ${pendingQuestion.prompt}`} />
              {pendingQuestion.options.map((option) => (
                <Button
                  key={option.id}
                  title={option.label}
                  variant={option.id === pendingQuestion.recommendedId ? "prim" : undefined}
                  onPress={() => void send(option.label)}
                />
              ))}
            </View>
          )}
        </ScrollView>
        <Composer
          text={text}
          onChangeText={setText}
          placeholder={t("offlinePlaceholder")}
          modeLabel={t("offlineSubtitle")}
          running={!!live}
          sending={false}
          stopping={false}
          onPlus={() => toast(t("offlinePlusUnavailable"))}
          onMode={() => toast(t("offlinePlusUnavailable"))}
          onSend={() => void send(text)}
          onStop={() => {
            engine.abort();
            toast(t("offlineStopped"));
          }}
        />
        <LeaveGuard dirty={!!text.trim()} title={t("leaveDraftTitle")} text={t("leaveDraftText")} />
      </KeyboardAvoidingView>
    </PageTint>
  );
}
