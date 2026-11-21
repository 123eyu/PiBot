import {
  type RefObject,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export function useMessageScroll({
  identity,
  active = true,
  pending,
  holdPosition,
  scroll,
  content,
  atBottom,
  anchor,
  messageIds,
  cancelFocus,
}: {
  identity: unknown;
  active?: boolean;
  pending: boolean;
  holdPosition: RefObject<boolean>;
  scroll: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  atBottom: RefObject<boolean>;
  anchor: RefObject<{ height: number; top: number } | undefined>;
  messageIds: readonly string[];
  cancelFocus(): void;
}) {
  const activation = useRef<{ identity: unknown; active: boolean } | undefined>(undefined);
  const lastTop = useRef(0);
  const seenIds = useRef(messageIds);
  const [state, setState] = useState({ away: false, newCount: 0 });
  const pin = useCallback(() => {
    const node = scroll.current;
    if (!node || !active || pending || holdPosition.current || anchor.current || !atBottom.current)
      return;
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
  }, [active, pending, holdPosition, scroll, anchor, atBottom]);
  const jumpLatest = useCallback(() => {
    cancelFocus();
    const node = scroll.current;
    if (!node) return;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    atBottom.current = true;
    anchor.current = undefined;
    setState({ away: false, newCount: 0 });
  }, [cancelFocus, scroll, atBottom, anchor]);
  useLayoutEffect(() => {
    const previous = seenIds.current;
    const appended =
      messageIds.length > previous.length &&
      messageIds.at(-1) !== previous.at(-1) &&
      previous.every((id, index) => messageIds[index] === id);
    if (!atBottom.current && appended) {
      const added = messageIds.length - previous.length;
      if (added) setState((value) => ({ ...value, newCount: value.newCount + added }));
    }
    seenIds.current = messageIds;
  }, [messageIds, atBottom]);
  useLayoutEffect(() => {
    const previous = activation.current;
    activation.current = { identity, active };
    if ((!previous || previous.identity !== identity || !previous.active) && active && !pending) {
      atBottom.current = true;
      anchor.current = undefined;
      setState({ away: false, newCount: 0 });
    }
    pin();
  });
  useLayoutEffect(() => {
    const node = scroll.current,
      body = content.current;
    if (!node || !body || !active) return;
    let frame: number | undefined;
    const changed = () => {
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          frame = undefined;
          pin();
        });
    };
    const observer = new ResizeObserver(changed);
    observer.observe(node);
    observer.observe(body);
    node.addEventListener("load", changed, true);
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) atBottom.current = false;
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) atBottom.current = false;
    };
    node.addEventListener("wheel", wheel, { passive: true });
    node.addEventListener("keydown", key);
    return () => {
      observer.disconnect();
      node.removeEventListener("load", changed, true);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("keydown", key);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [active, scroll, content, atBottom, pin]);
  useLayoutEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      const mac = navigator.platform.toLowerCase().includes("mac");
      if ((mac ? event.metaKey : event.ctrlKey) && event.key === "ArrowDown") {
        event.preventDefault();
        jumpLatest();
      } else if (event.key === "End") {
        event.preventDefault();
        jumpLatest();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, jumpLatest]);
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!active || pending) return false;
      const node = event.currentTarget;
      // Precise trackpad deltas must accumulate: a near-bottom band would re-pin every frame
      // before a light gesture could leave it. Only resume following at the actual bottom.
      const bottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
      const movingUp = node.scrollTop < lastTop.current;
      if (!holdPosition.current && (bottom || !atBottom.current || movingUp))
        atBottom.current = bottom && !movingUp;
      lastTop.current = node.scrollTop;
      const away =
        !bottom && node.scrollHeight - node.scrollTop - node.clientHeight > node.clientHeight;
      setState((value) => ({ away, newCount: away ? value.newCount : 0 }));
      return !holdPosition.current;
    },
    [active, pending, holdPosition, atBottom],
  );
  return { onScroll, jumpLatest, ...state };
}
