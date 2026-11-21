import type { PresentationObject } from "@pibot/protocol-base/office-content";
import { frame } from "./graphics.ts";
import type { ObjectContext } from "./object-context.ts";
import { fill, TABLE_URI } from "./parts.ts";
import { textBody } from "./text.ts";
export function table(input: Extract<PresentationObject, { type: "table" }>, ctx: ObjectContext) {
  const columns = input.rows[0]?.length ?? 1;
  const width = Math.round(ctx.box.width * ctx.width),
    height = Math.round(ctx.box.height * ctx.height);
  const grid = Array.from(
    { length: columns },
    (_, i) =>
      `<a:gridCol w="${Math.floor(width / columns) + (i === columns - 1 ? width % columns : 0)}"/>`,
  ).join("");
  const rows = input.rows
    .map((row, index) => tableRow(row, index, input.rows.length, ctx, height))
    .join("");
  return frame(
    ctx,
    `<a:graphicData uri="${TABLE_URI}"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData>`,
  );
}

function tableRow(row: string[], index: number, count: number, ctx: ObjectContext, height: number) {
  const cells = row.map((value) => tableCell(value, index, count, ctx)).join("");
  return `<a:tr h="${Math.floor(height / count)}">${cells}</a:tr>`;
}

function tableCell(value: string, row: number, count: number, ctx: ObjectContext) {
  const size = Math.max(8, Math.min(18, ((ctx.box.height * ctx.height) / 12700 / count) * 0.55));
  const color = row === 0 ? ctx.theme.onSection : ctx.theme.ink;
  const body = textBody(value, ctx.theme, {
    size,
    color,
    bold: row === 0,
    cell: true,
    centered: true,
  });
  const border = ["L", "R", "T", "B"]
    .map(
      (edge) =>
        `<a:ln${edge} w="6350">${fill(ctx.theme.background)}<a:prstDash val="solid"/></a:ln${edge}>`,
    )
    .join("");
  const background = fill(
    row === 0 ? ctx.theme.section : row % 2 ? ctx.theme.paper : ctx.theme.background,
  );
  return `<a:tc><a:txBody>${body}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${border}${background}</a:tcPr></a:tc>`;
}
