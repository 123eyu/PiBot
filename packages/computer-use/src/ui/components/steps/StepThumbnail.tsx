import { useRpc } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../computer.module.css";
import { thumbnailCache } from "./thumbnail-cache.ts";

/** Loads the step's thumbnail only once the row scrolls into view. */
export function StepThumbnail({
  stepId,
  available,
  icon = "file",
}: {
  stepId: string;
  available: boolean;
  /** What a step without a picture shows: a neutral kind icon, not a "hidden" eye. */
  icon?: "globe" | "file";
}) {
  const { peer } = useRpc();
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<{ key: string; source?: string; failed?: boolean }>();
  const cache = peer ? thumbnailCache(peer) : undefined;
  const key = stepId;
  const cached = cache?.cached(stepId);
  useEffect(() => {
    const element = box.current;
    if (!element || !available || cached) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [available, cached]);
  useEffect(() => {
    if (!cache || !visible || !available || cached) return;
    let active = true;
    cache
      .load(stepId)
      .then((source) => {
        if (active) setState({ key, source });
      })
      .catch(() => {
        if (active) setState({ key, failed: true });
      });
    return () => {
      active = false;
    };
  }, [cache, visible, available, cached, stepId, key]);
  const source = cached ?? (state?.key === key ? state.source : undefined);
  return (
    <span ref={box} className={styles.thumb} aria-hidden="true">
      {source ? <img src={source} alt="" /> : <Icon name={icon} size={14} />}
    </span>
  );
}
