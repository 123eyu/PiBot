import { useRpc, useT, waitRpc } from "@pibot/renderer-kit";
import { CloseButton } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../composer/attachments.module.css";

export function imageUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {
    /* Untrusted Markdown becomes text when the URL is invalid. */
  }
  return undefined;
}

export function ExternalImage({
  src,
  alt,
  botId,
  messageId,
  settled = true,
}: {
  src?: string;
  alt?: string;
  botId?: string;
  messageId?: string;
  settled?: boolean;
}) {
  const { peer } = useRpc();
  const t = useT();
  const url = imageUrl(src);
  const [allowed, setAllowed] = useState<boolean>();
  const [source, setSource] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    "network" | "not_image" | "too_large" | "denied" | "unsupported" | "cancelled"
  >();
  const [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLSpanElement>(null);
  const lifetime = useRef<{ abort: AbortController; requestId?: string } | undefined>(undefined);
  useEffect(() => {
    const current = { abort: new AbortController(), requestId: undefined as string | undefined };
    lifetime.current = current;
    let revision = 0;
    setAllowed(undefined);
    setSource(undefined);
    setBusy(false);
    setFailure(undefined);
    setZoom(false);
    const refresh = () => {
      if (!peer || !botId || !messageId || !src || !imageUrl(src) || !settled) return;
      const version = ++revision;
      const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(10000)]);
      setSource(undefined);
      setZoom(false);
      setAllowed(undefined);
      setBusy(false);
      if (current.requestId)
        void peer.call("chat.cancelExternalImage", { requestId: current.requestId }).catch(() => {
          /* Local teardown owns pending UI. */
        });
      current.requestId = undefined;
      void waitRpc(
        () => peer.call("chat.externalImageStatus", { botId, messageId, url: src }),
        signal,
      )
        .then((result) => {
          if (!current.abort.signal.aborted && version === revision) setAllowed(result.allowed);
        })
        .catch(() => {
          if (!current.abort.signal.aborted && version === revision) setAllowed(false);
        });
    };
    refresh();
    const unsubscribe = peer?.on("permissions.changed", (event) => {
      if (!event.botId || event.botId === botId) refresh();
    });
    return () => {
      current.abort.abort();
      unsubscribe?.();
      if (current.requestId && peer)
        void peer.call("chat.cancelExternalImage", { requestId: current.requestId }).catch(() => {
          /* No late image is retained by this component. */
        });
    };
  }, [peer, botId, messageId, src, settled]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && !entry.isIntersecting && !zoom) setSource(undefined);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [zoom]);
  useEffect(() => {
    if (zoom) dialog.current?.showModal();
  }, [zoom]);
  async function load() {
    const current = lifetime.current;
    if (!peer || !botId || !messageId || !src || !allowed || !current || busy) return;
    const requestId = crypto.randomUUID();
    current.requestId = requestId;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await waitRpc(
        () =>
          peer.call("chat.loadExternalImage", {
            botId,
            messageId,
            url: src,
            requestId,
            confirmed: true,
          }),
        AbortSignal.any([current.abort.signal, AbortSignal.timeout(30000)]),
      );
      if (current.abort.signal.aborted || current.requestId !== requestId) return;
      if (result.status === "loaded")
        setSource(`data:${result.image.mimeType};base64,${result.image.data}`);
      else {
        setFailure(result.status);
        if (result.status === "denied") setAllowed(false);
      }
    } catch {
      if (!current.abort.signal.aborted && current.requestId === requestId) setFailure("network");
    } finally {
      if (!current.abort.signal.aborted && current.requestId === requestId) {
        setBusy(false);
        current.requestId = undefined;
      }
      void peer.call("chat.cancelExternalImage", { requestId }).catch(() => {
        /* Cancellation has its own server deadline. */
      });
    }
  }
  if (!url) return <span>{alt}</span>;
  return (
    <span ref={container} className={styles.externalImage}>
      {source ? (
        <button
          type="button"
          className={styles.imageButton}
          onClick={() => setZoom(true)}
          aria-label={t("attachments.view", { name: alt ?? t("externalImage.title") })}
        >
          <img
            src={source}
            alt={alt ?? ""}
            className={styles.externalThumbnail}
            onError={() => {
              setSource(undefined);
              setFailure("not_image");
            }}
          />
        </button>
      ) : (
        <>
          <span aria-hidden="true">▧</span>
          <span>{alt || t("externalImage.title")}</span>
          <span>{t("externalImage.from", { domain: url.hostname })}</span>
          <button
            type="button"
            disabled={!allowed || busy || !peer || !botId || !messageId}
            onClick={() => void load()}
          >
            {t(
              busy
                ? "common.loading"
                : allowed === false
                  ? "externalImage.denied"
                  : "externalImage.load",
            )}
          </button>
          {failure && <span role="status">{t(`externalImage.${failure}`)}</span>}
        </>
      )}
      {zoom && (
        <dialog
          ref={dialog}
          className={styles.lightbox}
          aria-label={alt ?? t("externalImage.title")}
          onClose={() => setZoom(false)}
        >
          <div className={styles.lightboxHeader}>
            <CloseButton label={t("attachments.close")} onClick={() => dialog.current?.close()} />
          </div>
          <img src={source} alt={alt ?? ""} />
        </dialog>
      )}
    </span>
  );
}
