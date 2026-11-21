import type { BrowserElementSummary } from "@pibot/browser-contract/full";
import { type Peer, useT } from "@pibot/renderer-kit";
import { Button, CloseButton, IconTile } from "@pibot/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "../pane/bot-browser.module.css";
import { ElementOutline } from "../pane/ElementOutline.tsx";
import type { FrameMeta } from "../pane/use-browser-frames.ts";
import { framePoint } from "../takeover/use-takeover-input.ts";
import { BrowserDiagnosticsMenu } from "./BrowserDiagnosticsMenu.tsx";
import { publicBrowserAddress } from "./debug-feedback.ts";

export function BrowserDebugControls({
  botId,
  groupId,
  conversationId,
  peer,
  canvas,
  frameBox,
  meta,
  url,
  disabled,
  diagnosticsDisabled,
  onFeedback,
}: {
  botId: string;
  groupId?: string;
  conversationId: string;
  peer: Peer;
  canvas: RefObject<HTMLCanvasElement | null>;
  frameBox: RefObject<HTMLDivElement | null>;
  meta: FrameMeta | null;
  url: string;
  disabled: boolean;
  diagnosticsDisabled: boolean;
  onFeedback?(conversationId: string, text: string): void;
}) {
  const t = useT();
  const [selecting, setSelecting] = useState(false),
    [selected, setSelected] = useState<BrowserElementSummary>(),
    [hover, setHover] = useState<BrowserElementSummary>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [added, setAdded] = useState(false);
  const latest = useRef(meta);
  latest.current = meta;
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      active.current?.abort();
      setSelecting(false);
      setSelected(undefined);
      setHover(undefined);
      setBusy(false);
    }
  }, [disabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation invalidates selection without remounting the diagnostics popover.
  useEffect(() => {
    active.current?.abort();
    setSelecting(false);
    setSelected(undefined);
    setHover(undefined);
    setError(false);
    setBusy(false);
  }, [meta?.documentId, meta?.tabId]);
  useEffect(() => {
    const target = canvas.current;
    if (!selecting || disabled || !target) return;
    const original = target.style.cursor;
    target.style.cursor = "crosshair";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const inspect = (clientX: number, clientY: number, picked: boolean) => {
      const frame = latest.current;
      if (!frame?.documentId) return;
      const point = framePoint(target, frame, clientX, clientY);
      if (!point?.inside) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      if (picked) {
        setBusy(true);
        setError(false);
        setAdded(false);
      }
      void peer
        .call(
          "browser.inspectPoint",
          {
            botId,
            ...(groupId ? { groupId } : {}),
            conversationId,
            tabId: frame.tabId,
            documentId: frame.documentId,
            frameSeq: frame.seq,
            x: Math.floor(point.x),
            y: Math.floor(point.y),
          },
          { signal: controller.signal, timeoutMs: 15000 },
        )
        .then(
          (result) => {
            if (
              controller.signal.aborted ||
              ended ||
              latest.current?.documentId !== result.documentId
            )
              return;
            if (picked) {
              setSelected(result);
              setHover(undefined);
              setBusy(false);
              setSelecting(false);
            } else setHover(result);
          },
          () => {
            if (picked && !controller.signal.aborted && !ended) setError(true);
          },
        )
        .finally(() => {
          if (picked && !controller.signal.aborted && !ended) setBusy(false);
        });
    };
    const move = (event: PointerEvent) => {
      clearTimeout(timer);
      timer = setTimeout(() => inspect(event.clientX, event.clientY, false), 180);
    };
    const click = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearTimeout(timer);
      inspect(event.clientX, event.clientY, true);
    };
    const leave = () => {
      clearTimeout(timer);
      setHover(undefined);
    };
    const stop = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSelecting(false);
        setHover(undefined);
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerleave", leave);
    target.addEventListener("click", click, true);
    window.addEventListener("keydown", stop, true);
    return () => {
      ended = true;
      clearTimeout(timer);
      active.current?.abort();
      target.style.cursor = original;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("click", click, true);
      window.removeEventListener("keydown", stop, true);
    };
  }, [selecting, disabled, canvas, botId, groupId, conversationId, peer]);
  const element = selected ?? hover;
  const box = element?.bounds;
  return (
    <div className={styles.debugBar}>
      <BrowserDiagnosticsMenu
        botId={botId}
        groupId={groupId}
        conversationId={conversationId}
        peer={peer}
        tabId={meta?.tabId}
        documentId={meta?.documentId}
        url={url}
        disabled={diagnosticsDisabled}
        onFeedback={onFeedback}
      />
      <Button
        variant="ghost"
        aria-pressed={selecting}
        disabled={disabled || busy || !meta?.documentId || !onFeedback}
        aria-busy={busy}
        onClick={() => {
          setSelecting(!selecting);
          setSelected(undefined);
          setHover(undefined);
          setError(false);
          setBusy(false);
        }}
      >
        {t("browserDebug.select")}
      </Button>
      {frameBox.current &&
        createPortal(
          <>
            {element && element.documentId === meta?.documentId && meta && !disabled && (
              <ElementOutline element={element} meta={meta} canvas={canvas} />
            )}
            {selecting && (
              <div className={styles.inspectHint} role="status">
                <IconTile icon="search" tone="blue" size="sm" />
                <span className={styles.hintText}>{t("browserDebug.selectHint")}</span>
              </div>
            )}
            {selected && selected.documentId === meta?.documentId && !disabled && (
              <div className={styles.elementResult}>
                <span className={styles.elementHead}>
                  <IconTile icon="search" tone="blue" size="sm" />
                  <strong>
                    {t("agentWork.selectedElement", {
                      element: `<${selected.tag}> ${selected.name ?? ""}`,
                    })}
                  </strong>
                  <CloseButton
                    label={t("attachments.close")}
                    onClick={() => setSelected(undefined)}
                  />
                </span>
                {box && (
                  <span className={styles.elementBox}>
                    {Math.round(box.width)} × {Math.round(box.height)} · ({Math.round(box.x)},{" "}
                    {Math.round(box.y)})
                  </span>
                )}
                {selected.secret && <p>{t("browserDebug.secret")}</p>}
                {!selected.frameSupported && <p>{t("browserDebug.unsupported")}</p>}
                <Button
                  variant="pill"
                  className={styles.elementAdd}
                  disabled={added}
                  onClick={() => {
                    if (latest.current?.documentId !== selected.documentId) return;
                    onFeedback?.(
                      conversationId,
                      t("agentWork.elementFeedback", {
                        url: publicBrowserAddress(url),
                        element: `<${selected.tag}> ${selected.name ?? ""} [${selected.ref}]`,
                        position: box
                          ? `${Math.round(box.width)} × ${Math.round(box.height)} (${Math.round(box.x)}, ${Math.round(box.y)})`
                          : "",
                      }) +
                        "\n" +
                        selected.styles.map((style) => `${style.name}: ${style.value}`).join("\n"),
                    );
                    setAdded(true);
                  }}
                >
                  {t(added ? "browserDebug.added" : "browserDebug.add")}
                </Button>
              </div>
            )}
            {!selecting && !selected && error && (
              <div className={styles.inspectHint} role="alert">
                <IconTile icon="warning" tone="red" size="sm" />
                <span className={styles.hintText}>{t("browserDebug.failed")}</span>
                <Button
                  variant="pill"
                  className={styles.hintButton}
                  onClick={() => {
                    setError(false);
                    setSelecting(true);
                  }}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
          </>,
          frameBox.current,
        )}
    </div>
  );
}
