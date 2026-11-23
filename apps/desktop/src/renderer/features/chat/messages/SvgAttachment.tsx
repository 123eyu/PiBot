// Display an SVG as an image using the authorized preview read, with its file card as fallback.
import type { Attachment } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { FilePreviewContext } from "../../file-preview/context.tsx";
import { attachmentTarget } from "../../file-preview/state.ts";
import { OfficeAttachment } from "../../office/OfficeAttachment.tsx";
import styles from "../composer/attachments.module.css";
import { imageKey, imagePreviewCache } from "./image-preview-cache.ts";

const zeroVersion = () => 0;

function useSvgSource(attachment: Attachment, messageId: string, visible: boolean) {
  const { peer } = useRpc();
  const cache = peer ? imagePreviewCache(peer) : undefined;
  const key = imageKey(attachment);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key covers all attachment metadata.
  const image = useMemo(() => attachment, [key]);
  const subscribe = useCallback(
    (notify: () => void) => cache?.subscribe(key, notify) ?? (() => {}),
    [cache, key],
  );
  useSyncExternalStore(subscribe, cache?.version ?? zeroVersion);
  const revision = cache?.authorityVersion(image);
  const [result, setResult] = useState<{
    cache: typeof cache;
    messageId: string;
    revision: typeof revision;
    source?: string;
  }>();
  const current =
    result?.cache === cache && result?.messageId === messageId && result?.revision === revision
      ? result
      : undefined;

  useEffect(() => {
    if (!cache || !visible) {
      setResult(undefined);
      return;
    }
    const controller = new AbortController();
    const request = { cache, messageId, revision };
    void cache.svgSource(image, messageId, controller.signal).then(
      (source) => {
        if (!controller.signal.aborted) setResult({ ...request, source });
      },
      () => {
        if (!controller.signal.aborted) setResult(request);
      },
    );
    return () => controller.abort();
  }, [cache, image, messageId, revision, visible]);

  return {
    source: visible ? current?.source : undefined,
    failed: visible && !!current && !current.source,
    fail: () => setResult({ cache, messageId, revision }),
  };
}

export function SvgAttachment({
  attachment,
  messageId,
}: {
  attachment: Attachment;
  messageId: string;
}) {
  const t = useT();
  const openPreview = useContext(FilePreviewContext);
  const { peer } = useRpc();
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { source, failed, fail } = useSvgSource(attachment, messageId, visible && !!openPreview);

  return (
    <div ref={container}>
      {source && openPreview ? (
        <button
          type="button"
          className={styles.imageButton}
          onClick={() => openPreview(attachmentTarget(attachment, messageId))}
          aria-label={t("attachments.view", { name: attachment.name })}
        >
          <img
            src={source}
            alt={attachment.name}
            className={styles.thumbnail}
            onLoad={({ currentTarget }) => {
              if (currentTarget.naturalWidth * currentTarget.naturalHeight > 40_000_000) fail();
            }}
            onError={fail}
            loading="lazy"
          />
        </button>
      ) : failed || !peer || !openPreview ? (
        <OfficeAttachment attachment={attachment} messageId={messageId} readOnly={false} />
      ) : (
        <span className={styles.placeholder} role="status">
          {t("common.loading")}
        </span>
      )}
    </div>
  );
}
