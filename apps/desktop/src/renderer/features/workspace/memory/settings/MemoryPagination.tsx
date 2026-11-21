import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./memory-settings.module.css";

export function useMemoryCursor() {
  const [pages, setPages] = useState<string[]>([]);
  return {
    before: pages.at(-1),
    previous: () => setPages((p) => p.slice(0, -1)),
    next: (cursor: string) => setPages((p) => [...p, cursor]),
    reset: () => setPages([]),
  };
}

export function MemoryPagination({
  cursor,
  next,
  disabled,
}: {
  cursor: ReturnType<typeof useMemoryCursor>;
  next?: string | null;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className={styles.toolbar}>
      {cursor.before && (
        <Button
          variant="pill"
          className={styles.small}
          disabled={disabled}
          onClick={cursor.previous}
        >
          {t("memorySettings.previous")}
        </Button>
      )}
      {next && (
        <Button
          variant="pill"
          className={styles.small}
          disabled={disabled}
          onClick={() => cursor.next(next)}
        >
          {t("memorySettings.next")}
        </Button>
      )}
    </div>
  );
}
