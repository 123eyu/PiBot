import { type RefObject, useEffect, useState } from "react";

/**
 * Whether the pane can actually be seen: the document is visible (window not hidden or
 * minimized) and the element is laid out on screen (not display:none, e.g. the chat view kept
 * mounted behind another page). No frames are taken while nobody can see them.
 */
export function usePaneVisible(root: RefObject<HTMLElement | null>) {
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const change = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  // `onScreen` alone tells "the user left this view" apart from a minimized / locked window.
  return { visible: documentVisible && onScreen, onScreen };
}
