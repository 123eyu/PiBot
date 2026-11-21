import { Button, Icon, IconButton } from "@pibot/ui";
import { Fragment, useLayoutEffect, useRef } from "react";
import type { StartupTranslate } from "../../shared/startup-labels.ts";
import type { StartupAvatarLook, StartupSnapshot } from "../../shared/startup-snapshot.ts";
import styles from "../features/chat/chat.module.css";
import attachmentStyles from "../features/chat/composer/attachments.module.css";
import { messageTimeLabel } from "../features/chat/messages/message-time-label.ts";
import { userBubbleStyle } from "../features/chat/messages/user-bubble.ts";
import { CachedAvatar, CachedGroupAvatar } from "./startup-avatar.tsx";
import displayStyles from "./startup-display.module.css";

type Translate = StartupTranslate;
type Language = "zh" | "en";

/** Same markup and classes as ChatHeader, ChatMessage and the composer, as plain text. */
export function CachedChat({
  conversation,
  language,
  t,
}: {
  conversation?: StartupSnapshot["conversation"];
  language: Language;
  t: Translate;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  // The live history opens scrolled to the newest message; match it so nothing jumps.
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, []);
  const name = conversation?.name ?? "Pi Bot";
  const group = !!conversation?.groupId;
  const messages = conversation?.messages ?? [];
  const today = new Date().toDateString();
  return (
    <main className={styles.main}>
      <header className={styles.header} data-chat-header>
        <div className={styles.headerLead}>
          <span
            className={`${styles.headerAvatar} ${styles.headerAvatarButton}`}
            aria-hidden="true"
          >
            {group ? (
              <CachedGroupAvatar
                members={conversation?.members}
                memberCount={conversation?.memberCount}
                size={36}
              />
            ) : (
              <CachedAvatar look={conversation?.avatar} size={36} label={name} />
            )}
          </span>
          <div className={styles.headerIdentity}>
            <span className={styles.profileTrigger} title={name}>
              <strong>{name}</strong>
            </span>
            <div className={`${styles.headerSubtitle} ${styles.headerSubline}`} />
          </div>
        </div>
        <Button variant="pill" className={styles.newTopic} aria-label={t("workspace.newTopic")}>
          <Icon name="plus" size={14} />
          <span className={styles.newTopicLabel}>{t("workspace.newTopic")}</span>
        </Button>
      </header>
      <div className={styles.body}>
        <div className={styles.chatColumn}>
          <div ref={scroll} className={styles.scroll}>
            <div
              className={styles.messages}
              style={userBubbleStyle(conversation?.avatar?.color, group ? "group" : "dm")}
            >
              {conversation?.complete && messages.length > 0 && (
                <p className={styles.notice}>{t("chat.noMoreHistory")}</p>
              )}
              {messages.map((message, index) => {
                const time =
                  message.at &&
                  messageTimeLabel({
                    at: message.at,
                    previousAt: messages[index - 1]?.at,
                    firstTopicMessage: index === 0 && !!conversation?.complete,
                    today,
                    language,
                    t,
                  });
                return (
                  <Fragment key={message.id}>
                    {time && message.at && (
                      <div className={styles.timeSeparator}>
                        <time dateTime={message.at}>{time}</time>
                      </div>
                    )}
                    {message.role === "user" ? (
                      <article className={styles.user} aria-label={t("chat.you")}>
                        {message.text}
                      </article>
                    ) : (
                      <CachedReply
                        text={message.text}
                        sender={message.sender}
                        look={conversation?.avatar}
                        name={name}
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>
          <div className={styles.composerArea}>
            <form className={styles.composer}>
              <div className={attachmentStyles.menuAnchor}>
                <IconButton label={t("attachments.menu")} className={attachmentStyles.add}>
                  <svg
                    aria-hidden="true"
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </IconButton>
              </div>
              <textarea
                className={styles.input}
                rows={1}
                aria-label={t("chat.placeholder", { name })}
                placeholder={t("chat.placeholder", { name })}
                disabled
              />
              <div className={styles.sendOptions}>
                <button
                  type="button"
                  className={displayStyles.menuTrigger}
                  aria-label={t("chat.sendOptions")}
                  disabled
                >
                  <Icon name="chevron" size={16} />
                </button>
              </div>
              <IconButton
                className={styles.composerButton}
                type="button"
                variant="primary"
                label={t("chat.send")}
                disabled
              >
                <svg
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5m-6 6 6-6 6 6" />
                </svg>
              </IconButton>
            </form>
            <div className={styles.hint}>{t("chat.inputHint")}</div>
          </div>
        </div>
      </div>
    </main>
  );
}

function CachedReply({
  text,
  sender,
  look,
  name,
}: {
  text: string;
  sender?: { name: string; avatar: StartupAvatarLook };
  look?: StartupAvatarLook;
  name: string;
}) {
  return (
    <article
      className={`${styles.assistant} ${sender ? styles.withSender : ""}`}
      aria-label={sender?.name ?? name}
    >
      {sender && <div className={styles.sender}>{sender.name}</div>}
      <span className={styles.avatar}>
        <CachedAvatar look={sender?.avatar ?? look} size={28} label={sender?.name ?? name} />
      </span>
      <div className={styles.reply}>
        {/* Blank lines are the paragraph breaks Markdown would draw; no renderer on this path. */}
        <div className={styles.bubble}>
          {text.split(/\n{2,}/).map((paragraph, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>
    </article>
  );
}
