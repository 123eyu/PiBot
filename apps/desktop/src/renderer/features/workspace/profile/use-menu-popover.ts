import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef } from "react";

export function useMenuPopover(
  menu: RefObject<HTMLDivElement | null>,
  opener: HTMLElement,
  x: number,
  y: number,
  close: () => void,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    let restoreFocus = true;
    element.showPopover();
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    };
    position();
    // An inline failure/retry row can grow the open menu near a window edge.
    const observer = new ResizeObserver(position);
    observer.observe(element);
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = () => closeRef.current();
    const pointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !opener.contains(event.target)
      ) {
        restoreFocus = false;
        dismiss();
      }
    };
    const blur = () => {
      restoreFocus = false;
      dismiss();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) dismiss();
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) {
        restoreFocus = false;
        dismiss();
      }
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    window.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("scroll", scroll, true);
      element.hidePopover();
      if (restoreFocus && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [menu, opener, x, y]);
}

export function menuKeys(event: KeyboardEvent<HTMLDivElement>, close: () => void) {
  if (event.key === "Tab") {
    close();
    return;
  }
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  ];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % buttons.length
          : event.key === "ArrowUp"
            ? (index - 1 + buttons.length) % buttons.length
            : undefined;
  if (next !== undefined) {
    event.preventDefault();
    buttons[next]?.focus();
  }
}
