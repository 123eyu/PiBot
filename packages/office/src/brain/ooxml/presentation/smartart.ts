import type { PresentationObject } from "@pibot/protocol-base/office-content";
import type { ObjectContext } from "./object-context.ts";
import { shape } from "./objects.ts";
import { transform } from "./parts.ts";
import { type Box, rect, type Theme } from "./themes.ts";

type SmartArt = Extract<PresentationObject, { type: "smartart" }>;
type Piece = { box: Box; preset: string; text?: string; color?: string };

const LINE = 0.0002;
const GAP = 0.015;

/**
 * SmartArt ships as plain grouped shapes instead of a `dgm` part: it renders everywhere
 * and stays editable with the same shape APIs used for inserted objects.
 */
export function smartartObject(input: SmartArt, ctx: ObjectContext) {
  const pieces = layout(input, ctx.box, ctx.theme);
  const color = input.color ?? ctx.theme.colors[0];
  const accent = ctx.theme.colors[1] ?? color;
  const groupId = ctx.ids.next();
  const children = pieces.map((piece) =>
    piece.preset === "ring"
      ? ring(ctx.ids.next(), piece.box, accent, ctx.width, ctx.height)
      : shape(
          ctx.ids.next(),
          piece.preset,
          piece.box,
          piece.color ?? (piece.text === undefined ? accent : color),
          ctx.width,
          ctx.height,
          piece.text ?? "",
          piece.text === undefined ? undefined : ctx.theme,
        ),
  );
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${groupId}" name="SmartArt ${groupId}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${groupFrame(ctx.box, ctx.width, ctx.height)}<a:noFill/></p:grpSpPr>${children.join("")}</p:grpSp>`;
}

function groupFrame(box: Box, width: number, height: number) {
  const x = Math.round(box.x * width),
    y = Math.round(box.y * height),
    cx = Math.max(1, Math.round(box.width * width)),
    cy = Math.max(1, Math.round(box.height * height));
  // Child offsets mirror the group extent so nested shapes keep absolute slide coordinates.
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function ring(id: number, box: Box, color: string, width: number, height: number) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Ring ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box, width, height)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

function layout(input: SmartArt, area: Box, theme: Theme): Piece[] {
  const items = input.items;
  const count = items.length;
  switch (input.kind) {
    case "flow": {
      const gap = Math.min(0.03, area.width / (count * 3));
      const width = (area.width - gap * (count - 1)) / count;
      const height = area.height * 0.6;
      const y = area.y + area.height * 0.2;
      return items.map((text, index) => ({
        box: rect(area.x + index * (width + gap), y, width, height),
        preset: "chevron",
        text,
      }));
    }
    case "list": {
      const gap = Math.min(GAP, area.height / (count * 4));
      const height = (area.height - gap * (count - 1)) / count;
      const bar = Math.max(0.008, area.width * 0.02);
      const inset = bar + 0.01;
      return items.flatMap((text, index) => {
        const y = area.y + index * (height + gap);
        return [
          { box: rect(area.x, y, bar, height), preset: "rect" },
          { box: rect(area.x + inset, y, area.width - inset, height), preset: "roundRect", text },
        ] as Piece[];
      });
    }
    case "hierarchy": {
      const rootWidth = Math.min(area.width * 0.42, 0.46);
      const rootHeight = Math.max(0.12, area.height * 0.26);
      const root = rect(area.x + (area.width - rootWidth) / 2, area.y, rootWidth, rootHeight);
      const gap = Math.min(0.02, area.width / (count * 4));
      const childWidth = (area.width - gap * (count - 1)) / count;
      const childHeight = Math.max(0.14, area.height * 0.38);
      const childY = area.y + area.height - childHeight;
      const busY = root.y + root.height + (childY - root.y - root.height) / 2;
      const centers = items.map((_, index) => area.x + index * (childWidth + gap) + childWidth / 2);
      const bus: Piece[] = [
        {
          box: rect(
            root.x + root.width / 2 - LINE / 2,
            root.y + root.height,
            LINE,
            busY - root.y - root.height,
          ),
          preset: "rect",
        },
        {
          box: rect(
            centers[0] ?? area.x,
            busY - LINE / 2,
            (centers.at(-1) ?? area.x) - (centers[0] ?? area.x),
            LINE,
          ),
          preset: "rect",
        },
        ...centers.map((center) => ({
          box: rect(center - LINE / 2, busY, LINE, childY - busY),
          preset: "rect",
        })),
      ];
      return [
        ...bus,
        {
          box: root,
          preset: "roundRect",
          text: items[0],
          color: theme.colors[1] ?? theme.colors[0],
        },
        ...items.slice(1).map((text, index) => ({
          box: rect(area.x + index * (childWidth + gap), childY, childWidth, childHeight),
          preset: "roundRect",
          text,
        })),
      ];
    }
    case "cycle": {
      const radius = (Math.min(area.width, area.height) / 2) * 0.82;
      const size = Math.max(
        0.05,
        Math.min(Math.min(area.width, area.height) * 0.22, ((2 * Math.PI * radius) / count) * 0.75),
      );
      const cx = area.x + area.width / 2,
        cy = area.y + area.height / 2;
      return [
        { box: rect(cx - radius, cy - radius, radius * 2, radius * 2), preset: "ring" },
        ...items.map((text, index) => {
          const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
          return {
            box: rect(
              cx + Math.cos(angle) * radius - size / 2,
              cy + Math.sin(angle) * radius - size / 2,
              size,
              size,
            ),
            preset: "ellipse",
            text,
          };
        }),
      ];
    }
    case "matrix": {
      const columns = count <= 4 ? 2 : 3;
      const rows = Math.ceil(count / columns);
      const gap = Math.min(0.02, area.width / (columns * 6));
      const width = (area.width - gap * (columns - 1)) / columns;
      const height = (area.height - gap * (rows - 1)) / rows;
      return items.map((text, index) => ({
        box: rect(
          area.x + (index % columns) * (width + gap),
          area.y + Math.floor(index / columns) * (height + gap),
          width,
          height,
        ),
        preset: "rect",
        text,
      }));
    }
    case "timeline": {
      const y = area.y + area.height * 0.55;
      const size = Math.min(area.height * 0.18, area.width / (count * 2));
      const step = count > 1 ? (area.width - size) / (count - 1) : 0;
      const labelHeight = Math.max(0.1, area.height * 0.28);
      const labelWidth = Math.min(size * 3.4, area.width / count);
      const axis: Piece = { box: rect(area.x, y - LINE / 2, area.width, LINE), preset: "rect" };
      return [
        axis,
        ...items.flatMap((text, index) => {
          const cx = area.x + size / 2 + index * step;
          const above = index % 2 === 0;
          return [
            { box: rect(cx - size / 2, y - size / 2, size, size), preset: "ellipse" },
            {
              box: rect(
                Math.min(Math.max(area.x, cx - labelWidth / 2), area.x + area.width - labelWidth),
                above ? y - size / 2 - labelHeight - 0.01 : y + size / 2 + 0.01,
                labelWidth,
                labelHeight,
              ),
              preset: "roundRect",
              text,
            },
          ] as Piece[];
        }),
      ];
    }
  }
}
