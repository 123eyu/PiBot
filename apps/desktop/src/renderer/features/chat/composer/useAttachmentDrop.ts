import { type DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from "react";

function hasFiles(event: DragEvent | ReactDragEvent) {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export function useAttachmentDrop(add: (files: File[]) => Promise<void>, enabled = true) {
  const root = useRef<HTMLElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);
  useEffect(() => {
    if (!enabled) {
      reset();
      // Retaining a hidden chat keeps drafts alive; block file navigation without accepting new files.
      const preventNavigation = (event: DragEvent) => {
        if (!hasFiles(event) && !event.dataTransfer?.files.length) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      };
      window.addEventListener("dragover", preventNavigation, true);
      window.addEventListener("drop", preventNavigation, true);
      return () => {
        window.removeEventListener("dragover", preventNavigation, true);
        window.removeEventListener("drop", preventNavigation, true);
      };
    }
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    };
    // Chromium's default file drop navigates, including drops outside the chat target.
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const inside = event.target instanceof Node && root.current?.contains(event.target);
      if (event.dataTransfer) event.dataTransfer.dropEffect = inside ? "copy" : "none";
      depth.current = Math.max(1, depth.current);
      setDragging(true);
    };
    const drop = (event: DragEvent) => {
      if (hasFiles(event) || event.dataTransfer?.files.length) event.preventDefault();
      reset();
    };
    const leave = (event: DragEvent) => {
      if (
        !event.relatedTarget &&
        (event.target === document ||
          event.target === document.documentElement ||
          event.clientX <= 0 ||
          event.clientY <= 0 ||
          event.clientX >= window.innerWidth ||
          event.clientY >= window.innerHeight)
      )
        reset();
      else {
        // New child's enter arrives before old child's leave; the window depth stays positive.
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      }
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [reset, enabled]);
  return {
    root,
    dragging,
    handlers: {
      onDragOver(event: ReactDragEvent<HTMLElement>) {
        if (!enabled || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDrop(event: ReactDragEvent<HTMLElement>) {
        reset();
        if (!enabled || (!hasFiles(event) && !event.dataTransfer.files.length)) return;
        event.preventDefault();
        void add(Array.from(event.dataTransfer.files));
      },
    },
  };
}
