import type { InboxItem } from "@pibot/protocol";
import {
  BotAvatar,
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button, type IconName, IconTile, type Tone } from "@pibot/ui";
import type { CSSProperties, ReactNode } from "react";
import styles from "./inbox.module.css";

export function inboxAge(at: string, language: string, justNow: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always" });
  // "0 分钟前" read like a glitch on a card that just arrived (second-Mac test).
  if (minutes < 1) return justNow;
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), "hour");
  return format.format(-Math.floor(minutes / 1440), "day");
}

/** Every kind keeps one colour and mark, shown as the card's left bar and its tile. */
export function inboxMark(item: Pick<InboxItem, "kind">): { icon: IconName; tone: Tone } {
  switch (item.kind) {
    case "approval":
      return { icon: "shield", tone: "amber" };
    case "routine_approval":
      return { icon: "shield", tone: "orange" };
    case "user_question":
      return { icon: "message", tone: "violet" };
    case "group_plan":
    case "group_plan_action":
      return { icon: "users", tone: "teal" };
    case "memory":
      return { icon: "user", tone: "pink" };
    case "connector_auth":
      return { icon: "link", tone: "blue" };
    case "provider":
      return { icon: "key", tone: "violet" };
    case "computer_handoff":
      return { icon: "hand", tone: "pink" };
    case "background_task":
      return { icon: "terminal", tone: "green" };
    case "personal_todo":
      return { icon: "check", tone: "amber" };
    case "routine_trigger_error":
      return { icon: "warning", tone: "red" };
    default:
      return { icon: "clock", tone: "orange" };
  }
}

/** The same origin footer surrounds every inbox kind, including capability-owned cards. */
export function InboxOriginCard({
  item,
  close,
  children,
}: {
  item: InboxItem;
  close(): void;
  children: ReactNode;
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const data = useWorkspace();
  const action = useAction();
  const { navigate } = useNavigation();
  const origin = item.origin;
  const bot = data.bots.find((bot) => bot.id === origin?.botId);
  // A to-do the person wrote themselves has no Bot or conversation behind it.
  const own = item.kind === "personal_todo" && !origin?.botId;
  const name =
    origin?.botName ?? bot?.name ?? t(own ? "workspace.inboxYours" : "workspace.inboxSystem");
  const at = item.cursor.split("|")[0] ?? "";
  const oldQuestion =
    item.kind === "user_question" &&
    !item.pause.answer &&
    Date.now() - Date.parse(item.message.createdAt) > 3 * 86_400_000;
  const mark = inboxMark(item);
  return (
    <article
      className={styles.card}
      data-inbox-kind={item.kind}
      style={
        {
          "--kind": mark.tone === "red" ? "var(--danger)" : `var(--avatar-${mark.tone})`,
        } as CSSProperties
      }
    >
      <div className={styles.cardBody}>
        <IconTile icon={mark.icon} tone={mark.tone} className={styles.kindMark} />
        <div className={styles.cardContent}>{children}</div>
      </div>
      <footer className={styles.origin}>
        <BotAvatar bot={bot} unknown label={name} size={20} />
        <span className={styles.originText}>
          <strong>{origin?.groupName ? `${origin.groupName} · ${name}` : name}</strong>
          <span>
            {origin?.conversationTitle ??
              t(
                origin?.conversationId
                  ? "workspace.inboxUntitled"
                  : own
                    ? "workspace.inboxAddedByYou"
                    : "workspace.inboxNoConversation",
              )}
          </span>
          <time dateTime={at}>{inboxAge(at, language, t("workspace.inboxJustNow"))}</time>
          {oldQuestion && <span>{t("workspace.inboxOldQuestion")}</span>}
        </span>
        {origin?.conversationId && (
          <Button
            variant="ghost"
            className={styles.openChat}
            disabled={!peer || action.busy}
            onClick={() => {
              const conversationId = origin.conversationId;
              if (!peer || !conversationId) return;
              void action.run(async (signal) => {
                const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
                let target: Awaited<ReturnType<typeof locateConversation>>;
                if (origin.groupId && origin.conversationKind === "group") {
                  await peer.call(
                    "groups.topics.switch",
                    {
                      groupId: origin.groupId,
                      topicId: conversationId,
                    },
                    { signal: bounded, timeoutMs: 30_000 },
                  );
                  target = { name: "chat", groupId: origin.groupId };
                } else {
                  target = await locateConversation(
                    peer,
                    conversationId,
                    bounded,
                    data.bots,
                    data.groups,
                    origin.botId ?? undefined,
                  );
                }
                signal.throwIfAborted();
                close();
                navigate({
                  ...target,
                  ...(origin.messageId ? { focus: { messageId: origin.messageId } } : {}),
                });
              });
            }}
          >
            {t("workspace.inboxOpenChat")}
          </Button>
        )}
      </footer>
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </article>
  );
}
