import { type KeyboardEvent, type RefObject, useLayoutEffect, useState } from "react";
import { MAX_GROUP_MEMBERS, type NewGroupState } from "./use-new-group.ts";

/** ↑↓ move through the member list from the search field or a row; Enter in the field toggles. */
export function useRecipientKeyboard(
  state: NewGroupState,
  input: RefObject<HTMLInputElement | null>,
  id: string,
) {
  const [activeKey, setActiveKey] = useState<string>();
  const rows = state.filtered.map((bot) => bot.id);
  const optionId = (key: string) => `${id}-${key}`;
  const disabled = (key: string) =>
    state.task.busy || (state.picked.length >= MAX_GROUP_MEMBERS && !state.picked.includes(key));
  const active =
    rows.find((row) => row === activeKey && !disabled(row)) ?? rows.find((row) => !disabled(row));
  useLayoutEffect(() => {
    if (active) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);
  const choose = (key: string) => {
    if (disabled(key)) return;
    const bot = state.filtered.find((bot) => bot.id === key);
    if (bot) state.toggle(bot);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    const inOption =
      event.target instanceof Element &&
      !!event.target.closest('[role="option"]') &&
      event.target.closest('[role="listbox"]')?.id === id;
    // Form fields and child Combobox portals must keep their own shortcuts and selection state.
    if (event.target !== input.current && !inOption) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const enabled = rows.filter((key) => !disabled(key));
      const index = active ? enabled.indexOf(active) : -1;
      const next =
        enabled[
          Math.max(0, Math.min(enabled.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
        ];
      setActiveKey(next);
      if (inOption && next) document.getElementById(optionId(next))?.focus();
    } else if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (active) choose(active);
    }
  };
  return { active, setActiveKey, optionId, disabled, choose, keyDown };
}

export type RecipientKeyboard = ReturnType<typeof useRecipientKeyboard>;
