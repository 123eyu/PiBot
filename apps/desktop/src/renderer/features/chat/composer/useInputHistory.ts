import { type Message, messageVisibleText } from "@pibot/protocol";
import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { atInputHistoryBoundary } from "./input-history-boundary.ts";

type Direction = "up" | "down";
interface HistoryPosition {
  conversationId: string;
  messageId: string;
  draft: string;
}

export function inputHistoryDirection(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "keyCode" | "isComposing" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
  composing: boolean,
  input: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">,
): Direction | undefined {
  if (
    composing ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    input.selectionStart !== input.selectionEnd
  )
    return undefined;
  if (event.key === "ArrowUp" && !input.value.slice(0, input.selectionStart).includes("\n"))
    return "up";
  if (event.key === "ArrowDown" && !input.value.slice(input.selectionEnd).includes("\n"))
    return "down";
  return undefined;
}

export function selectInputHistory(
  messages: readonly Message[],
  conversationId: string | undefined,
  text: string,
  position: HistoryPosition | undefined,
  direction: Direction,
): { text: string; position?: HistoryPosition } | undefined {
  if (!conversationId) return undefined;
  const history = messages.filter(
    (message) =>
      message.conversationId === conversationId &&
      message.role === "user" &&
      // A routine's trigger message is not something the user typed.
      !message.routineTrigger &&
      messageVisibleText(message).trim(),
  );
  const browsing = position?.conversationId === conversationId ? position : undefined;
  const index = browsing ? history.findIndex((message) => message.id === browsing.messageId) : -1;
  if (direction === "down" && index < 0) return undefined;
  if (direction === "down" && index === history.length - 1)
    return { text: browsing?.draft ?? text };
  const next =
    history[direction === "up" ? (index < 0 ? history.length - 1 : index - 1) : index + 1];
  if (!next) return undefined;
  return {
    // FORWARD-DISPLAY: recalling a forward edits its note, not the hidden material.
    text: messageVisibleText(next),
    // IDs keep the cursor stable when the existing history pagination prepends messages.
    position: { conversationId, messageId: next.id, draft: browsing?.draft ?? text },
  };
}

export function useInputHistory(
  conversationId: string | undefined,
  messages: readonly Message[],
  text: string,
  setText: Dispatch<SetStateAction<string>>,
  textarea: RefObject<HTMLTextAreaElement | null>,
) {
  const position = useRef<HistoryPosition | undefined>(undefined);
  const caret = useRef<{ text: string; offset: number } | undefined>(undefined);
  const reset = useCallback(() => {
    position.current = undefined;
    caret.current = undefined;
  }, []);
  useLayoutEffect(() => {
    if (position.current?.conversationId !== conversationId) reset();
  }, [conversationId, reset]);
  useLayoutEffect(() => {
    if (caret.current?.text === text && textarea.current) {
      textarea.current.setSelectionRange(caret.current.offset, caret.current.offset);
      caret.current = undefined;
    }
  }, [text, textarea]);
  const edit = useCallback(
    (value: string) => {
      reset();
      setText(value);
    },
    [reset, setText],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => {
    const direction = inputHistoryDirection(event.nativeEvent, composing, event.currentTarget);
    if (!direction) return false;
    const next = selectInputHistory(messages, conversationId, text, position.current, direction);
    if (!next || !atInputHistoryBoundary(event.currentTarget, direction)) return false;
    event.preventDefault();
    position.current = next.position;
    const offset = direction === "up" ? 0 : next.text.length;
    if (next.text === text) event.currentTarget.setSelectionRange(offset, offset);
    else caret.current = { text: next.text, offset };
    setText(next.text);
    return true;
  };
  return { edit, onKeyDown, reset };
}
