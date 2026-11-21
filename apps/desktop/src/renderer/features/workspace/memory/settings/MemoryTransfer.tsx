import type { MemoryOwner, MethodParams } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, IconTile } from "@pibot/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MemoryMenu } from "./MemoryMenu.tsx";
import { memoryErrorKey } from "./memory-error.ts";
import styles from "./memory-settings.module.css";
import { decodeMemories, encodeMemories, type ImportEntry } from "./transfer.ts";

export function MemoryTransfer({
  owner,
  busy,
  changed,
  onBusyChange,
  children,
}: {
  children?: ReactNode;
  owner: MemoryOwner;
  busy: boolean;
  changed(): void;
  onBusyChange(value: boolean): void;
}) {
  const { peer } = useRpc();
  const t = useT();
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef<AbortController | null>(null);
  const downloadUrl = useRef<string | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<
    "memorySettings.invalidImport" | ReturnType<typeof memoryErrorKey>
  >();
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [counts, setCounts] = useState({ added: 0, duplicate: 0, skipped: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Imported data and pending work belong to this connection.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setEntries([]);
    setCounts({ added: 0, duplicate: 0, skipped: 0 });
    setIndex(0);
    setWorking(false);
    onBusyChange(false);
    return () => {
      controller.abort();
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = undefined;
      lifetime.current = null;
    };
  }, [peer, owner.scope, owner.ownerId, onBusyChange]);
  const run = async (operation: (signal: AbortSignal) => Promise<void>, failed: typeof error) => {
    const controller = lifetime.current;
    if (
      (locked.current && !locked.current.signal.aborted) ||
      !controller ||
      controller.signal.aborted
    )
      return;
    locked.current = controller;
    setWorking(true);
    onBusyChange(true);
    setError(undefined);
    try {
      await operation(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(failed === "memorySettings.invalidImport" ? failed : memoryErrorKey(error));
    } finally {
      if (locked.current === controller) locked.current = null;
      if (!controller.signal.aborted) {
        setWorking(false);
        onBusyChange(false);
      }
    }
  };
  const disabled = busy || working || !peer;
  const exportAll = () =>
    run(async (signal) => {
      if (!peer) return;
      const items: ImportEntry[] = [];
      let before: string | undefined;
      const ids = new Set<string>();
      let expectedCount: number | undefined;
      let expectedRevision: number | undefined;
      for (let page = 0; page <= 40; page++) {
        const result = await peer.call(
          "memory.browse",
          { scope: owner.scope, ownerId: owner.ownerId, state: "all", before, expectedRevision },
          { signal, timeoutMs: 30_000 },
        );
        signal.throwIfAborted();
        const count = result.activeCount + result.archivedCount;
        if (expectedCount === undefined) expectedCount = count;
        if (expectedRevision === undefined) expectedRevision = result.revision;
        if (count > 2000) throw new Error("memory_export_limit");
        if (count !== expectedCount) throw new Error("memory_export_changed");
        for (const item of result.items) {
          if (ids.has(item.id)) throw new Error("memory_export_cursor");
          ids.add(item.id);
          items.push({ text: item.text, category: item.category });
        }
        if (items.length > 2000) throw new Error("memory_export_limit");
        if (result.items.length < 50) {
          if (items.length !== expectedCount) throw new Error("memory_export_changed");
          const blob = new Blob([encodeMemories(items)], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
          downloadUrl.current = url;
          try {
            signal.throwIfAborted();
            const a = document.createElement("a");
            a.href = url;
            a.download = `pibot-memory-${owner.scope}.md`;
            a.click();
          } catch (error) {
            URL.revokeObjectURL(url);
            downloadUrl.current = undefined;
            throw error;
          }
          return;
        }
        before = result.items.at(-1)?.id;
      }
      throw new Error("memory_export_limit");
    }, "memorySettings.exportLimit");
  const accept = () =>
    run(async (signal) => {
      const entry = entries[index];
      if (!entry || !peer) return;
      const change: MethodParams["memory.manage"]["change"] = { action: "import", ...entry };
      const result = await peer.call(
        "memory.manage",
        { scope: owner.scope, ownerId: owner.ownerId, confirmed: true, change },
        { signal, timeoutMs: 30_000 },
      );
      signal.throwIfAborted();
      setCounts((n) => ({
        ...n,
        added: n.added + (result.status === "added" ? 1 : 0),
        duplicate: n.duplicate + (result.status === "duplicate" ? 1 : 0),
      }));
      setIndex((n) => n + 1);
      changed();
    }, "memorySettings.failed");
  const entry = entries[index];
  return (
    <div className={styles.transfer} data-memory-transfer>
      <MemoryMenu label={t("memorySettings.moreMenu")} above>
        <Button variant="ghost" disabled={disabled} onClick={() => void exportAll()}>
          <IconTile icon="download" tone="blue" size="sm" />
          {t("memorySettings.export")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || !!entry}
          onClick={() =>
            void run(async (signal) => {
              const content = await peer?.call(
                "memory.pickImport",
                {},
                { signal, timeoutMs: 630_000 },
              );
              signal.throwIfAborted();
              if (content == null) return;
              const parsed = decodeMemories(content);
              setEntries(parsed);
              setIndex(0);
              setCounts({ added: 0, duplicate: 0, skipped: 0 });
            }, "memorySettings.invalidImport")
          }
        >
          <IconTile icon="file" tone="violet" size="sm" />
          {t("memorySettings.import")}
        </Button>
        {children}
      </MemoryMenu>
      {working && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      {entry && (
        <div className={`${styles.card} ${styles.review}`}>
          <div className={styles.reviewHead}>
            <strong>
              {t("memorySettings.importReview", { current: index + 1, total: entries.length })}
            </strong>
            <Chip tone="violet">{t(`workspace.category.${entry.category ?? "other"}`)}</Chip>
          </div>
          <p className={styles.text}>{entry.text}</p>
          <div className={styles.toolbar}>
            <Button
              className={`${styles.small} ${styles.toneFill}`}
              disabled={disabled}
              onClick={() => void accept()}
            >
              {t("memorySettings.acceptImport")}
            </Button>
            <Button
              variant="pill"
              className={styles.small}
              disabled={disabled}
              onClick={() => {
                setIndex((n) => n + 1);
                setCounts((n) => ({ ...n, skipped: n.skipped + 1 }));
              }}
            >
              {t("memorySettings.skipImport")}
            </Button>
            <Button
              variant="ghost"
              className={styles.small}
              disabled={disabled}
              onClick={() => {
                setEntries([]);
                setIndex(0);
              }}
            >
              {t("memorySettings.cancelImport")}
            </Button>
          </div>
        </div>
      )}
      {!!(counts.added + counts.duplicate + counts.skipped) && (
        <p role="status" className={styles.meta}>
          {t("memorySettings.importResult", counts)}
        </p>
      )}
    </div>
  );
}
