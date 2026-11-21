import { useT } from "@pibot/renderer-kit";
import type { ChangesDiff } from "@pibot/workspaces-contract/full";
import styles from "../changes.module.css";

type OfficeChangesData = NonNullable<ChangesDiff["office"]>;
type OfficeChange = OfficeChangesData["items"][number];

const KIND_KEY = {
  slide: "changes.office.kind.slide",
  shape: "changes.office.kind.shape",
  paragraph: "changes.office.kind.paragraph",
  table: "changes.office.kind.table",
  comment: "changes.office.kind.comment",
  revision: "changes.office.kind.revision",
  sheet: "changes.office.kind.sheet",
  cell_range: "changes.office.kind.cell_range",
  chart: "changes.office.kind.chart",
  pivot: "changes.office.kind.pivot",
} as const;

/**
 * A zipped package has no lines, so the changes are listed where the reader knows
 * them — per slide, sheet or document body — with reverts where supported.
 */
export function OfficeChanges({
  data,
  editable,
  stale,
  discard,
  discardFile,
}: {
  data: OfficeChangesData;
  editable: boolean;
  /** The file no longer matches the digest the list was built from. */
  stale: boolean;
  discard?(item: OfficeChange): void;
  discardFile?(): void;
}) {
  const t = useT();
  const retractableCount =
    editable && discard && !stale ? data.items.filter((item) => item.retractable).length : 0;
  const bannerKey =
    retractableCount === 0
      ? "changes.diff.officeReadOnly"
      : retractableCount === data.items.length
        ? "changes.diff.office"
        : "changes.diff.officePartial";
  const groups = new Map<number | null, OfficeChange[]>();
  for (const item of data.items) {
    const group = groups.get(item.page);
    if (group) group.push(item);
    else groups.set(item.page, [item]);
  }
  return (
    <section className={styles.office}>
      <div className={styles.bannerInfo}>
        <span>{t(bannerKey, { count: data.items.length, retractableCount })}</span>
        {editable && discardFile && (
          <button type="button" className={styles.miniAccent} onClick={discardFile}>
            {t("changes.discard.file")}
          </button>
        )}
      </div>
      {stale && <p className={styles.officeNote}>{t("changes.diff.officeStale")}</p>}
      {[...groups].map(([page, items]) => (
        <div key={page ?? 0} className={styles.officeGroup}>
          {page !== null && (
            <p className={styles.officePage}>{t("changes.diff.officePage", { page })}</p>
          )}
          {items.map((item) => (
            <article key={item.id} className={styles.officeItem}>
              <header className={styles.officeHead}>
                <b>{item.name ?? t(KIND_KEY[item.kind])}</b>
                {item.area && <span className={styles.officeArea}>{item.area}</span>}
                {editable && discard && item.retractable && !stale ? (
                  <button type="button" className={styles.miniAccent} onClick={() => discard(item)}>
                    {t("changes.discard.officeItem")}
                  </button>
                ) : (
                  !item.retractable && (
                    <span className={styles.officeNote}>{t("changes.diff.officeUnavailable")}</span>
                  )
                )}
              </header>
              {item.before !== null && <p className={styles.officeBefore}>{item.before}</p>}
              {item.after !== null && <p className={styles.officeAfter}>{item.after}</p>}
            </article>
          ))}
        </div>
      ))}
      {data.omitted > 0 && (
        <p className={styles.officeNote}>
          {t("changes.diff.officeOmitted", { count: data.omitted })}
        </p>
      )}
    </section>
  );
}
