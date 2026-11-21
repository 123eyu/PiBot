import { type Peer, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";
import { useConnectorRead } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";
import styles from "./connectors.module.css";
import { ImportedSkillAssignment } from "./ImportedSkillAssignment.tsx";

/** Recovery stays reachable even when a skill-only import has no connection card. */
export function PendingImportedSkills({ changed }: { changed(): void }) {
  const { t, language } = useSettings();
  const [snapshot, setSnapshot] = useState(0);
  const [position, setPosition] = useState<{ snapshot: number; cursors: (string | undefined)[] }>({
    snapshot: 0,
    cursors: [undefined],
  });
  const cursors = position.snapshot === snapshot ? position.cursors : [undefined];
  const before = cursors.at(-1);
  const page = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        peer.call("plugins.pendingSkillAssignments", { before, limit: 25 }, { signal }),
      [before],
    ),
  );
  const refresh = page.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An unchanged first-page cursor still needs fresh counts.
  useEffect(() => refresh(), [snapshot, refresh]);
  useRpcEvent("plugins.changed", () => setSnapshot((value) => value + 1));
  if (!page.loading && !page.error && page.value?.totalCount === 0) return null;
  return (
    <section className={styles.stack}>
      <ConnectorFeedback loading={page.loading} error={page.error} retry={refresh} />
      {!!page.value?.totalCount && (
        <details className={styles.card}>
          <summary>{t("connectors.pendingSkillImports", { count: page.value.totalCount })}</summary>
          <div className={styles.stack}>
            {page.value.items.map((item) => (
              <section key={item.installationId} className={styles.stack}>
                <h3>{item.name[language]}</h3>
                <ImportedSkillAssignment
                  installationId={item.installationId}
                  changed={() => {
                    refresh();
                    changed();
                  }}
                />
              </section>
            ))}
            <ConnectorPagination
              previous={
                cursors.length > 1
                  ? () => setPosition({ snapshot, cursors: cursors.slice(0, -1) })
                  : undefined
              }
              next={
                page.value.nextBefore
                  ? () =>
                      setPosition({
                        snapshot,
                        cursors: [...cursors, page.value?.nextBefore ?? undefined],
                      })
                  : undefined
              }
              disabled={page.loading || !!page.error}
            />
          </div>
        </details>
      )}
    </section>
  );
}
