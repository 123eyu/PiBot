import { messageShownText } from "@pibot/client-core";
import { type Message, type MessageQuote, messageForward, messageQuote } from "@pibot/protocol";
import { revealFileLabel, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button, Icon, IconButton, IconTile } from "@pibot/ui";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { menuKeys, useMenuPopover } from "../../workspace/profile/use-menu-popover.ts";
import { copyableImage, copyImage } from "./copy-image.ts";
import { MessageActionsProvider, useMessageActions } from "./MessageActionsContext.tsx";
import { MessageRetryDialog } from "./MessageRetryDialog.tsx";
import styles from "./message-reply.module.css";

type Draft = { message: Message; name: string };
type Menu = Draft & {
  x: number;
  y: number;
  opener: HTMLElement;
  attachmentId?: string;
  /** For a Bot reply: the user message that started its run, the one a retry starts from. */
  retryFrom?: Message;
};
const ReplyContext = createContext<
  { draft?: Draft; clear(id?: string): void; open(menu: Menu): void } | undefined
>(undefined);
export function MessageReplyProvider({ children }: { children: ReactNode }) {
  return (
    <MessageActionsProvider>
      <ReplyProvider>{children}</ReplyProvider>
    </MessageActionsProvider>
  );
}
function ReplyProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft>();
  const [menu, setMenu] = useState<Menu>();
  const [retry, setRetry] = useState<Message>();
  const { view } = useNavigation();
  const workspace = useWorkspace();
  const retryBot =
    view.name === "chat" && !view.groupId && !view.threadId
      ? workspace.bots.find(
          (bot) => (view.botId ? bot.id === view.botId : bot.isMain) && bot.category !== "image",
        )
      : undefined;
  // Navigation abandons a dialog tied to its original message and Bot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes own dialog lifetime
  useEffect(
    () => setRetry(undefined),
    [view.botId, view.topicId, view.groupId, view.threadId, view.name],
  );
  const value = useMemo(
    () => ({
      draft,
      clear: (id?: string) =>
        setDraft((current) => (!id || current?.message.id === id ? undefined : current)),
      open: setMenu,
    }),
    [draft],
  );
  return (
    <ReplyContext.Provider value={value}>
      {children}
      {menu && (
        <ReplyMenu
          key={`${menu.message.id}:${menu.attachmentId ?? "text"}:${menu.x}:${menu.y}`}
          menu={menu}
          close={() => setMenu((current) => (current === menu ? undefined : current))}
          retry={
            retryBot && retrySource(menu) && !retrySource(menu)?.routineTrigger
              ? () => {
                  setRetry(retrySource(menu));
                  setMenu(undefined);
                }
              : undefined
          }
          choose={() => {
            setDraft({ message: menu.message, name: menu.name });
            setMenu(undefined);
          }}
        />
      )}
      {retry && retryBot && (
        <MessageRetryDialog message={retry} botId={retryBot.id} close={() => setRetry(undefined)} />
      )}
    </ReplyContext.Provider>
  );
}
/** A user message retries from itself; a Bot reply from the user message that started its run. */
function retrySource(menu: Menu) {
  if (menu.message.role === "user") return menu.message;
  return menu.message.role === "assistant" && menu.retryFrom?.role === "user"
    ? menu.retryFrom
    : undefined;
}
function ReplyMenu({
  menu,
  close,
  choose,
  retry,
}: {
  menu: Menu;
  close(): void;
  choose(): void;
  retry?: () => void;
}) {
  const t = useT(),
    ref = useRef<HTMLDivElement>(null);
  const { peer } = useRpc();
  const actions = useMessageActions();
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState<"copy" | "reveal">();
  const image = copyableImage(menu.message, menu.attachmentId);
  // A generated image's text is only a placeholder; the image is what the user wants to copy.
  const copying = useRef<AbortController>(undefined);
  useEffect(() => () => copying.current?.abort(), []);
  useMenuPopover(ref, menu.opener, menu.x, menu.y, close);
  // A forward copies only what the user wrote, never the hidden material.
  const copyText = messageShownText(menu.message, t);
  return (
    <div
      ref={ref}
      popover="manual"
      role="menu"
      aria-label={t("messages.actions")}
      className={styles.menu}
      onKeyDown={(e) => menuKeys(e, close)}
    >
      <Button variant="ghost" role="menuitem" onClick={choose}>
        <IconTile icon="quote" tone="blue" size="sm" />
        {t("chat.quote")}
      </Button>
      {retry && (
        <Button variant="ghost" role="menuitem" onClick={retry}>
          <IconTile icon="refresh" tone="orange" size="sm" />
          {t("messages.retry")}
        </Button>
      )}
      <hr />
      <Button
        variant="ghost"
        role="menuitem"
        disabled={pending || !copyText}
        onClick={() => {
          setPending(true);
          setFailed(undefined);
          void navigator.clipboard.writeText(copyText).then(close, () => {
            setPending(false);
            setFailed("copy");
          });
        }}
      >
        <IconTile icon="copy" tone="neutral" size="sm" />
        {t("messages.copy")}
      </Button>
      {image && (
        <Button
          variant="ghost"
          role="menuitem"
          disabled={!peer || pending}
          onClick={() => {
            if (!peer || pending) return;
            setPending(true);
            setFailed(undefined);
            copying.current = new AbortController();
            void copyImage(peer, menu.message, image, copying.current.signal).then(close, () => {
              setPending(false);
              setFailed("copy");
            });
          }}
        >
          <IconTile icon="image" tone="neutral" size="sm" />
          {t(pending ? "chat.copyingImage" : "chat.copyImage")}
        </Button>
      )}
      {actions && menu.message.role !== "error" && (
        <>
          <hr />
          <Button
            variant="ghost"
            role="menuitem"
            // The brain translates the stored text, which for a forward is the hidden material
            // and for a routine's trigger message the model's instructions.
            disabled={
              !menu.message.content.trim() ||
              !!messageForward(menu.message) ||
              !!menu.message.routineTrigger
            }
            onClick={() => {
              actions.translate(menu.message);
              close();
            }}
          >
            <IconTile icon="globe" tone="violet" size="sm" />
            {t("messages.translate")}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              actions.select(menu.message, menu.name);
              close();
            }}
          >
            <IconTile icon="check" tone="teal" size="sm" />
            {t("messages.select")}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              actions.transfer(menu.message, menu.name, false);
              close();
            }}
          >
            <IconTile icon="send" tone="pink" size="sm" />
            {t("messages.forward")}
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              actions.transfer(menu.message, menu.name, true);
              close();
            }}
          >
            <IconTile icon="users" tone="teal" size="sm" />
            {t("messages.createGroup")}
          </Button>
        </>
      )}
      {menu.attachmentId && (
        <>
          <hr />
          <Button
            variant="ghost"
            role="menuitem"
            disabled={!peer || pending}
            onClick={() => {
              if (!peer || !menu.attachmentId || pending) return;
              setPending(true);
              setFailed(undefined);
              const controller = new AbortController();
              copying.current = controller;
              void peer
                .call(
                  "chat.revealAttachment",
                  {
                    id: menu.attachmentId,
                    messageId: menu.message.id,
                  },
                  { signal: controller.signal, timeoutMs: 20_000 },
                )
                .then(close, () => {
                  if (controller.signal.aborted) return;
                  setPending(false);
                  setFailed("reveal");
                });
            }}
          >
            <IconTile icon="folder" tone="blue" size="sm" />
            {t(revealFileLabel())}
          </Button>
        </>
      )}
      {failed && (
        <p role="alert">{t(failed === "copy" ? "messages.copyFailed" : "log.actionError")}</p>
      )}
    </div>
  );
}
export function useMessageReply() {
  return useContext(ReplyContext);
}
export function useMessageReplyMenu(
  message: Message,
  name: string,
  preview: boolean,
  retryFrom?: Message,
) {
  const reply = useMessageReply();
  const actions = useMessageActions();
  if (!reply || preview || message.status === "streaming") return {};
  const open = (opener: HTMLElement, x: number, y: number, target: EventTarget | null) => {
    const image =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-file-attachment-id], [data-image-attachment-id]")
        : null;
    const attachmentId =
      image &&
      opener.contains(image) &&
      message.attachments?.find(
        (a) => a.id === (image.dataset.fileAttachmentId ?? image.dataset.imageAttachmentId),
      )?.id;
    reply.open({
      message,
      name,
      opener,
      x,
      y,
      ...(attachmentId ? { attachmentId } : {}),
      ...(retryFrom ? { retryFrom } : {}),
    });
  };
  return {
    tabIndex: 0,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!actions?.selecting || message.role === "error") return;
      event.preventDefault();
      event.stopPropagation();
      actions.toggle(message, name);
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      open(event.currentTarget, event.clientX, event.clientY, event.target);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        actions?.selecting &&
        message.role !== "error" &&
        (event.key === " " || event.key === "Enter") &&
        event.target === event.currentTarget
      ) {
        event.preventDefault();
        actions.toggle(message, name);
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        open(event.currentTarget, box.left, box.bottom, event.target);
      }
    },
  };
}
function QuoteSummary({
  quote,
  name,
}: {
  quote: Pick<MessageQuote, "role" | "content" | "attachments">;
  name: string;
}) {
  const t = useT();
  const images = quote.attachments.filter((a) => a.kind === "image").length;
  return (
    <div className={styles.summary}>
      <strong>{quote.role === "user" ? t("chat.you") : name}</strong>
      <span>
        {quote.content.slice(0, 2000) || t(images ? "chat.quoteImage" : "chat.quoteAttachment")}
      </span>
      {images > 0 && <small>{t("chat.quoteImages", { count: images })}</small>}
    </div>
  );
}
export function ReplyDraft({
  textarea,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}) {
  const t = useT(),
    reply = useMessageReply(),
    draft = reply?.draft;
  useEffect(() => {
    if (draft) textarea.current?.focus();
  }, [draft, textarea]);
  if (!draft || !reply) return null;
  return (
    <aside className={styles.draft} aria-label={t("chat.quoting")}>
      <QuoteSummary
        name={draft.name}
        quote={{
          role: draft.message.role,
          content: messageShownText(draft.message, t),
          attachments: draft.message.attachments ?? [],
        }}
      />
      <IconButton label={t("chat.cancelQuote")} disabled={disabled} onClick={() => reply.clear()}>
        <Icon name="close" size={16} />
      </IconButton>
    </aside>
  );
}
export function QuotedMessage({ message }: { message: Message }) {
  const quote = messageQuote(message);
  if (!quote) return null;
  return (
    <div className={styles.record}>
      <QuoteSummary quote={quote} name={quote.author} />
    </div>
  );
}
