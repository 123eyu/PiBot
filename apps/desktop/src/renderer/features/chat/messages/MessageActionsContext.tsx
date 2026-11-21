import { messageShownText } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageTransferDialog } from "./MessageTransferDialog.tsx";
import styles from "./message-actions.module.css";

export type SelectedMessage = { message: Message; name: string };
type Translation = { status: "loading" | "done" | "error"; text?: string; language: "zh" | "en" };
interface Actions {
  selecting: boolean;
  selected: ReadonlyMap<string, SelectedMessage>;
  select(message: Message, name: string): void;
  toggle(message: Message, name: string): void;
  transfer(message: Message, name: string, createGroup: boolean): void;
  translate(message: Message): void;
  translations: ReadonlyMap<string, Translation>;
  hideTranslation(id: string): void;
}
const Context = createContext<Actions | undefined>(undefined);
export const useMessageActions = () => useContext(Context);
export function MessageActionsProvider({ children }: { children: ReactNode }) {
  const { peer } = useRpc(),
    { language } = useSettings(),
    t = useT();
  const [selecting, setSelecting] = useState(false),
    [selected, setSelected] = useState(new Map<string, SelectedMessage>());
  const [translations, setTranslations] = useState(new Map<string, Translation>());
  const [dialog, setDialog] = useState<{ items: SelectedMessage[]; createGroup: boolean }>();
  const [copyError, setCopyError] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const toggle = (message: Message, name: string) =>
    setSelected((old) => {
      const next = new Map(old);
      if (next.has(message.id)) next.delete(message.id);
      else if (
        next.size < 50 &&
        (!next.size ||
          next.values().next().value?.message.conversationId === message.conversationId)
      )
        next.set(message.id, { message, name });
      return next;
    });
  const translate = (message: Message) => {
    const signal = lifetime.current?.signal;
    if (
      !peer ||
      !signal ||
      signal.aborted ||
      !message.content.trim() ||
      message.status === "streaming"
    )
      return;
    if (translations.get(message.id)?.status === "loading") return;
    setTranslations((old) => new Map(old).set(message.id, { status: "loading", language }));
    void peer
      .call(
        "messages.translate",
        { conversationId: message.conversationId, messageId: message.id, language },
        { signal, timeoutMs: 95000 },
      )
      .then(
        (result) => {
          if (!signal.aborted)
            setTranslations((old) =>
              old.get(message.id)?.status === "loading" &&
              old.get(message.id)?.language === language
                ? new Map(old).set(message.id, { status: "done", ...result })
                : old,
            );
        },
        () => {
          if (!signal.aborted)
            setTranslations((old) =>
              old.get(message.id)?.status === "loading" &&
              old.get(message.id)?.language === language
                ? new Map(old).set(message.id, { status: "error", language })
                : old,
            );
        },
      );
  };
  const value: Actions = {
    selecting,
    selected,
    toggle,
    translate,
    translations,
    select(message, name) {
      setSelected(new Map([[message.id, { message, name }]]));
      setSelecting(true);
    },
    transfer(message, name, createGroup) {
      setDialog({ items: [{ message, name }], createGroup });
    },
    hideTranslation(id) {
      setTranslations((old) => {
        const next = new Map(old);
        next.delete(id);
        return next;
      });
    },
  };
  const items = useMemo(
    () =>
      [...selected.values()].sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt)),
    [selected],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {selecting && (
        <aside
          className={styles.selectionBar}
          aria-label={t("messages.selected", { count: selected.size })}
        >
          <strong className={styles.selectedCount}>
            <Icon name="check" size={13} />
            {t("messages.selected", { count: selected.size })}
          </strong>
          <Button
            variant="ghost"
            disabled={!items.length}
            onClick={() => {
              setCopyError(false);
              void navigator.clipboard
                .writeText(
                  items
                    .map(
                      ({ message, name }) =>
                        `${message.role === "user" ? t("chat.you") : name}:\n${messageShownText(message, t)}`,
                    )
                    .join("\n\n"),
                )
                .catch(() => setCopyError(true));
            }}
          >
            <Icon name="copy" size={16} />
            {t("messages.copy")}
          </Button>
          <Button
            variant="secondary"
            disabled={!items.length}
            onClick={() => setDialog({ items, createGroup: false })}
          >
            <Icon name="send" size={14} />
            {t("messages.forward")}
          </Button>
          <Button
            variant="secondary"
            disabled={!items.length}
            onClick={() => setDialog({ items, createGroup: true })}
          >
            <Icon name="users" size={14} />
            {t("messages.createGroup")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSelecting(false);
              setSelected(new Map());
              setCopyError(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          {copyError && <span role="alert">{t("messages.copyFailed")}</span>}
        </aside>
      )}
      {dialog && (
        <MessageTransferDialog
          items={dialog.items}
          createGroup={dialog.createGroup}
          close={() => setDialog(undefined)}
          done={() => {
            setDialog(undefined);
            setSelecting(false);
            setSelected(new Map());
          }}
        />
      )}
    </Context.Provider>
  );
}
