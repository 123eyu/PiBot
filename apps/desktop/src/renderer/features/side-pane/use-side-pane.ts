import { useCallback, useEffect, useState } from "react";

export type SidePaneTab = "changes" | "tasks" | "browser" | "preview";
export interface SidePaneState {
  open: boolean;
  tab: SidePaneTab;
  wide: boolean;
  /** Bot browser only: the pane covers the whole chat area. */
  full: boolean;
}

/**
 * Open / tab / wide state of the chat's right sidebar, shared by the changes view and
 * the Bot browser. ⌘⇧E (Ctrl+Shift+E elsewhere) toggles the wide layout while it is open.
 */
export function useSidePane(active: boolean) {
  const [state, setState] = useState<SidePaneState>({
    open: false,
    tab: "changes",
    wide: false,
    full: false,
  });
  // Fullscreen belongs to the browser view; any other tab or closing the pane leaves it.
  const show = useCallback(
    (tab: SidePaneTab) =>
      setState((s) => ({ ...s, open: true, tab, full: tab === "browser" && s.full })),
    [],
  );
  const toggle = useCallback(
    (tab: SidePaneTab) =>
      setState((s) =>
        s.open && s.tab === tab
          ? { ...s, open: false, full: false }
          : { ...s, open: true, tab, full: tab === "browser" && s.full },
      ),
    [],
  );
  const close = useCallback(() => setState((s) => ({ ...s, open: false, full: false })), []);
  const toggleWide = useCallback(() => setState((s) => ({ ...s, wide: !s.wide })), []);
  const toggleFull = useCallback(
    () => setState((s) => ({ ...s, open: true, tab: "browser", full: !s.full })),
    [],
  );
  useEffect(() => {
    if (!active || !state.open || state.full) return;
    const onKey = (event: KeyboardEvent) => {
      const command = navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
      if (command && event.shiftKey && !event.altKey && event.code === "KeyE") {
        event.preventDefault();
        toggleWide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, state.open, state.full, toggleWide]);
  return { ...state, show, toggle, close, toggleWide, toggleFull };
}
export type SidePaneControl = ReturnType<typeof useSidePane>;
