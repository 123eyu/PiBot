import { nextReply } from "@pibot/client-core";
import type { ChatNotice, Message } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ExecutionTopic } from "../../execution/workspace.tsx";
import styles from "./next-reply.module.css";

export function useNextReplySuggestion(options: {
  conversationId?: string;
  messages: readonly Message[];
  topics: readonly ExecutionTopic[];
  notices: readonly ChatNotice[];
  hidden: boolean;
  text: string;
  edit(text: string): void;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const id = useId();
  const [dismissed, setDismissed] = useState<string>();
  const [composing, setComposing] = useState(false);
  const caret = useRef<string | undefined>(undefined);
  const candidate = nextReply(
    options.conversationId,
    options.messages,
    options.topics,
    options.notices,
  );
  const visible =
    candidate && candidate.id !== dismissed && !options.hidden && !options.text && !composing;
  const text = visible ? t(candidate.key) : undefined;
  const dismiss = () => setDismissed(candidate?.id);
  const accept = () => {
    if (!text) return;
    dismiss();
    caret.current = text;
    options.edit(text);
  };
  useLayoutEffect(() => {
    if (caret.current !== undefined && options.text === caret.current) {
      options.textarea.current?.focus();
      options.textarea.current?.setSelectionRange(options.text.length, options.text.length);
      caret.current = undefined;
    }
  }, [options.text, options.textarea]);
  return {
    text,
    id: text ? id : undefined,
    accept,
    dismiss,
    composition: setComposing,
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, inComposition: boolean) {
      if (
        !text ||
        inComposition ||
        composing ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return false;
      if (event.key !== "Tab" && event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Tab") accept();
      else dismiss();
      return true;
    },
  };
}

export function NextReplyField({
  suggestion,
  children,
}: {
  suggestion: ReturnType<typeof useNextReplySuggestion>;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.field}>
      {children}
      {suggestion.text && (
        <div className={styles.suggestion}>
          <span className={styles.label}>{t("nextReply.label")}</span>
          <span className={styles.text}>{suggestion.text}</span>
          <button
            type="button"
            tabIndex={-1}
            className={styles.accept}
            title={`${suggestion.text}\n${t("nextReply.hint")}`}
            aria-label={t("nextReply.accept", { text: suggestion.text })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={suggestion.accept}
          >
            <kbd>Tab</kbd>
          </button>
        </div>
      )}
      {suggestion.text && (
        <span id={suggestion.id} className={styles.description}>
          {t("nextReply.label")} · {suggestion.text} · {t("nextReply.hint")}
        </span>
      )}
    </div>
  );
}
