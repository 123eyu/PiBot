// biome-ignore-all lint/suspicious/noArrayIndexKey: read-only cells are identified by fixed row and column coordinates
import type { OfficeCell, OfficeContent } from "@pibot/office-contract/full";
import { useT } from "@pibot/renderer-kit";
import styles from "./office.module.css";

function Cell({ value }: { value: OfficeCell }) {
  const t = useT();
  if (typeof value === "object" && value !== null)
    return (
      <td title={t("office.formula", { formula: value.formula })} className={styles.formula}>
        {value.cachedValue === undefined ? t("office.noCachedValue") : String(value.cachedValue)}
        <small>{`=${value.formula}`}</small>
      </td>
    );
  return <td>{value === null ? "" : String(value)}</td>;
}

function columnName(index: number) {
  let remaining = index + 1;
  let name = "";
  while (remaining > 0) {
    remaining--;
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

export function OfficeContentView({ content, offset }: { content: OfficeContent; offset: number }) {
  const t = useT();
  if (content.kind === "docx")
    return (
      <div className={styles.document}>
        {content.title && <h2>{content.title}</h2>}
        {!content.blocks.length && <p>{t("office.empty")}</p>}
        {content.blocks.map((block, index) => {
          const key = block.id ?? `block-${offset + index}`;
          if (block.type === "table")
            return (
              <div className={styles.tableScroll} key={key}>
                <table>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={`row-${r}`}>
                        {row.map((cell, c) => (
                          <td key={`cell-${c}`}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          const Heading = `h${block.type === "heading" ? block.level : 1}` as "h1";
          return block.type === "heading" ? (
            <Heading key={key} className={styles.heading} data-level={block.level}>
              {block.text}
            </Heading>
          ) : (
            <p key={key}>{block.text}</p>
          );
        })}
      </div>
    );
  if (content.kind === "xlsx")
    return (
      <div className={styles.workbook}>
        {content.sheets.map((sheet) => (
          <section key={sheet.name}>
            <h3>{sheet.name}</h3>
            {!sheet.rows.length ? (
              <p>{t("office.empty")}</p>
            ) : (
              <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th aria-label={t("office.row")} />
                      {Array.from(
                        { length: Math.max(0, ...sheet.rows.map((row) => row.length)) },
                        (_, column) => (
                          <th key={columnName(column)} scope="col">
                            {columnName(column)}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, index) => (
                      <tr key={`row-${offset + index}`}>
                        <th scope="row">{offset + index + 1}</th>
                        {row.map((cell, column) => (
                          <Cell key={`cell-${column}`} value={cell} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
    );
  return (
    <div className={styles.slides}>
      {content.slides.map((slide, index) => (
        <section key={slide.id ?? `slide-${offset + index}`} className={styles.slide}>
          <small>{t("office.slideNumber", { number: offset + index + 1 })}</small>
          {slide.title && <h2>{slide.title}</h2>}
          <p>{slide.text || (!slide.title ? t("office.empty") : "")}</p>
        </section>
      ))}
    </div>
  );
}
