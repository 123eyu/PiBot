import { useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useMemorySummary } from "../workspace/memory/use-memory-summary.ts";
import { useOpenMemory } from "../workspace/memory/use-open-memory.ts";
import styles from "./app-menu.module.css";

export function AboutYouMenuItem({ close }: { close(): void }) {
  const t = useT();
  const openMemory = useOpenMemory();
  const { data, failed } = useMemorySummary({ scope: "user", ownerId: "user" });
  return (
    <Button
      variant="ghost"
      role="menuitem"
      aria-label={t("appMenu.aboutYou")}
      onClick={() => {
        close();
        openMemory({ scope: "user", ownerId: "user" });
      }}
    >
      <IconTile icon="user" tone="pink" size="sm" />
      <span>{t("appMenu.aboutYou")}</span>
      <span
        role="status"
        className={styles.memoryCount}
        data-user-memory-count={data ? data.activeCount + data.archivedCount : undefined}
        aria-label={
          data
            ? t("panel.memoryCount", { count: data.activeCount + data.archivedCount })
            : t(failed ? "memorySettings.failed" : "common.loading")
        }
        title={failed ? t("memorySettings.failed") : undefined}
      >
        {data ? data.activeCount + data.archivedCount : failed ? "—" : "…"}
      </span>
    </Button>
  );
}
