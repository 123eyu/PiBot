import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useSettingsDialog(onClose: () => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    const initial =
      element?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      element?.querySelector<HTMLElement>("button");
    initial?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    const timer = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.target instanceof Element && event.target.closest("dialog") !== event.currentTarget)
      return;
    if (event.key !== "Tab") return;
    const elements = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"], summary',
      ),
    ].filter(
      (element) =>
        element.getClientRects().length && !element.closest("[hidden], fieldset:disabled"),
    );
    const first = elements[0];
    const last = elements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === event.currentTarget)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return { dialog, closing, close: () => setClosing(true), trapFocus };
}
