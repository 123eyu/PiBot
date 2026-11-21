import type { PptOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import type { Element } from "../xml.ts";
import {
  apply,
  type Frame,
  frameEdits,
  frameOf,
  qualifiedTag,
  rewriteNode,
  shapeIds,
  shapeNode,
  shapesIn,
  shapeTree,
  slidePart,
  slideSize,
  treeSource,
} from "./edit-base.ts";

type ShapeOperation = Extract<
  PptOperation,
  {
    op:
      | "ppt_transform"
      | "ppt_delete"
      | "ppt_duplicate"
      | "ppt_align"
      | "ppt_distribute"
      | "ppt_size"
      | "ppt_z_order"
      | "ppt_group"
      | "ppt_ungroup"
      | "ppt_snap";
  }
>;

export function isShapeOperation(operation: PptOperation): operation is ShapeOperation {
  return !operation.op.startsWith("ppt_slide_");
}

export function applyShapeOperation(pkg: OfficePackage, operation: ShapeOperation) {
  const { part, xml } = slidePart(pkg, operation.slide);
  const tree = shapeTree(xml);
  const source = xml.source;
  let next = source;
  switch (operation.op) {
    case "ppt_transform": {
      const size = slideSize(pkg);
      const node = shapeNode(xml, operation.shapeId);
      const frame = frameOf(node);
      next = apply(
        source,
        frameEdits(source, node, {
          x: operation.x === undefined ? frame.x : operation.x * size.width,
          y: operation.y === undefined ? frame.y : operation.y * size.height,
          width: operation.width === undefined ? frame.width : operation.width * size.width,
          height: operation.height === undefined ? frame.height : operation.height * size.height,
        }),
      );
      break;
    }
    case "ppt_delete": {
      const node = shapeNode(xml, operation.shapeId);
      next = treeSource(
        source,
        tree,
        tree.children.filter((item) => item !== node),
      );
      break;
    }
    case "ppt_duplicate": {
      const size = slideSize(pkg);
      const node = shapeNode(xml, operation.shapeId);
      const frame = frameOf(node);
      const clone = renumber(
        rewriteNode(source, node, {
          x: operation.x === undefined ? slideX(frame.x, size.width) : operation.x * size.width,
          y: operation.y === undefined ? slideY(frame.y, size.height) : operation.y * size.height,
          width: frame.width,
          height: frame.height,
        }),
        shapeIds(xml),
      );
      next =
        source.slice(0, tree.openEnd) +
        tree.children
          .map((item) =>
            item === node
              ? source.slice(item.start, item.end) + clone
              : source.slice(item.start, item.end),
          )
          .join("") +
        source.slice(tree.closeStart);
      break;
    }
    case "ppt_align": {
      const nodes = operation.shapeIds.map((id) => shapeNode(xml, id));
      const frames = nodes.map((node) => frameOf(node));
      const union = bounds(frames);
      const edits = nodes.flatMap((node, index) => {
        const frame = frames[index];
        if (!frame) throw new Error("office_target_ambiguous");
        const target = { ...frame };
        if (operation.align === "left") target.x = union.x;
        if (operation.align === "center") target.x = union.x + union.width / 2 - frame.width / 2;
        if (operation.align === "right") target.x = union.x + union.width - frame.width;
        if (operation.align === "top") target.y = union.y;
        if (operation.align === "middle") target.y = union.y + union.height / 2 - frame.height / 2;
        if (operation.align === "bottom") target.y = union.y + union.height - frame.height;
        return target.x === frame.x && target.y === frame.y ? [] : frameEdits(source, node, target);
      });
      next = apply(source, edits);
      break;
    }
    case "ppt_distribute": {
      const nodes = operation.shapeIds.map((id) => shapeNode(xml, id));
      const horizontal = operation.axis === "horizontal";
      const order = [...nodes].sort((left, right) =>
        horizontal ? frameOf(left).x - frameOf(right).x : frameOf(left).y - frameOf(right).y,
      );
      const frames = order.map((node) => frameOf(node));
      const first = frames[0],
        last = frames.at(-1);
      if (!first || !last) throw new Error("office_target_ambiguous");
      const span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y;
      const occupied = frames.reduce(
        (sum, frame) => sum + (horizontal ? frame.width : frame.height),
        0,
      );
      const gap = (span - occupied) / (frames.length - 1);
      const edits = order.flatMap((node, index) => {
        const frame = frames[index];
        if (!frame || index === 0) return [];
        const previous = frames[index - 1];
        const offset = (horizontal ? previous?.x : previous?.y) ?? 0;
        const extent = horizontal ? (previous?.width ?? 0) : (previous?.height ?? 0);
        const position = offset + extent + gap;
        return frameEdits(source, node, {
          ...frame,
          ...(horizontal ? { x: position } : { y: position }),
        });
      });
      next = apply(source, edits);
      break;
    }
    case "ppt_size": {
      const nodes = operation.shapeIds.map((id) => shapeNode(xml, id));
      const frames = nodes.map((node) => frameOf(node));
      const width = Math.max(...frames.map((frame) => frame.width));
      const height = Math.max(...frames.map((frame) => frame.height));
      const edits = nodes.flatMap((node, index) => {
        const frame = frames[index];
        if (!frame) throw new Error("office_target_ambiguous");
        return frameEdits(source, node, {
          ...frame,
          width: operation.dimension === "height" ? frame.width : width,
          height: operation.dimension === "width" ? frame.height : height,
        });
      });
      next = apply(source, edits);
      break;
    }
    case "ppt_z_order": {
      const node = shapeNode(xml, operation.shapeId);
      const shapes = shapesIn(tree);
      const slots = tree.children.flatMap((item, position) =>
        shapes.includes(item) ? [position] : [],
      );
      const index = shapes.indexOf(node);
      if (index < 0) throw new Error("office_unsupported");
      shapes.splice(index, 1);
      if (operation.direction === "front") shapes.push(node);
      else if (operation.direction === "back") shapes.unshift(node);
      else if (operation.direction === "forward")
        shapes.splice(Math.min(index + 1, shapes.length), 0, node);
      else shapes.splice(Math.max(index - 1, 0), 0, node);
      const reordered = [...tree.children];
      slots.forEach((slot, position) => {
        const shape = shapes[position];
        if (shape) reordered[slot] = shape;
      });
      next = treeSource(source, tree, reordered);
      break;
    }
    case "ppt_group": {
      const nodes = operation.shapeIds.map((id) => shapeNode(xml, id));
      if (nodes.some((node) => !tree.children.includes(node)))
        throw new Error("office_unsupported");
      const frames = nodes.map((node) => frameOf(node));
      const union = bounds(frames);
      const groupId = shapeIds(xml) + 1;
      const tag = qualifiedTag(source, tree);
      const prefix = tag.includes(":") ? `${tag.split(":")[0]}:` : "";
      const frame = groupFrame(prefix, union);
      const group = `<${prefix}grpSp><${prefix}nvGrpSpPr><${prefix}cNvPr id="${groupId}" name="Group ${groupId}"/><${prefix}cNvGrpSpPr/><${prefix}nvPr/></${prefix}nvGrpSpPr><${prefix}grpSpPr>${frame}<a:noFill/></${prefix}grpSpPr>${nodes
        .map((node) => source.slice(node.start, node.end))
        .join("")}</${prefix}grpSp>`;
      const selected = new Set(nodes);
      const inner = tree.children
        .map((item) =>
          nodes[0] === item ? group : selected.has(item) ? "" : source.slice(item.start, item.end),
        )
        .join("");
      next = source.slice(0, tree.openEnd) + inner + source.slice(tree.closeStart);
      break;
    }
    case "ppt_ungroup": {
      const node = shapeNode(xml, operation.shapeId);
      if (node.name !== "grpSp") throw new Error("office_unsupported");
      const xfrm = node.children
        .find((item) => item.name === "grpSpPr")
        ?.children.find((item) => item.name === "xfrm");
      if (
        ["rot", "flipH", "flipV"].some((key) => xfrm?.attrs.get(key) && xfrm.attrs.get(key) !== "0")
      )
        throw new Error("office_unsupported");
      const frame = xfrmParts(node);
      const children = shapesIn(node)
        .map((child) => {
          const childFrame = frameOf(child);
          return rewriteNode(source, child, {
            x: frame.x + (childFrame.x - frame.childX) * frame.scaleX,
            y: frame.y + (childFrame.y - frame.childY) * frame.scaleY,
            width: childFrame.width * frame.scaleX,
            height: childFrame.height * frame.scaleY,
          });
        })
        .join("");
      if (!children) throw new Error("office_unsupported");
      next = source.slice(0, node.start) + children + source.slice(node.end);
      break;
    }
    case "ppt_snap": {
      const size = slideSize(pkg);
      const stepX = operation.grid * size.width,
        stepY = operation.grid * size.height;
      const edits = operation.shapeIds.flatMap((id) => {
        const node = shapeNode(xml, id);
        const frame = frameOf(node);
        return frameEdits(source, node, {
          ...frame,
          x: Math.min(Math.max(0, Math.round(frame.x / stepX) * stepX), size.width - frame.width),
          y: Math.min(Math.max(0, Math.round(frame.y / stepY) * stepY), size.height - frame.height),
        });
      });
      next = apply(source, edits);
      break;
    }
  }
  if (next !== source) pkg.replaceXml(part, next);
}

function slideX(value: number, width: number) {
  return Math.min(value + width * 0.02, width * 0.9);
}
function slideY(value: number, height: number) {
  return Math.min(value + height * 0.02, height * 0.9);
}

/** Duplicated groups would otherwise repeat their children's cNvPr ids within one slide. */
function renumber(clone: string, lastId: number) {
  let next = lastId;
  return clone.replace(
    /(<(?:[\w.-]+:)?cNvPr\b[^>]*?\bid=")(\d+)(")/gu,
    (_match, head: string, _id: string, tail: string) => `${head}${++next}${tail}`,
  );
}

function bounds(frames: Frame[]): Frame {
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function groupFrame(prefix: string, frame: Frame) {
  const x = Math.round(frame.x),
    y = Math.round(frame.y),
    cx = Math.max(1, Math.round(frame.width)),
    cy = Math.max(1, Math.round(frame.height));
  // chOff/chExt equal the group origin so nested shapes keep their slide coordinates.
  return `<${prefix}xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></${prefix}xfrm>`;
}

function xfrmParts(node: Element) {
  const position = frameOf(node);
  const xfrm = node.children
    .find((item) => item.name === "grpSpPr")
    ?.children.find((item) => item.name === "xfrm");
  const childX = Number(xfrm?.children.find((item) => item.name === "chOff")?.attrs.get("x") ?? 0);
  const childY = Number(xfrm?.children.find((item) => item.name === "chOff")?.attrs.get("y") ?? 0);
  const childWidth = Number(
    xfrm?.children.find((item) => item.name === "chExt")?.attrs.get("cx") ?? 0,
  );
  const childHeight = Number(
    xfrm?.children.find((item) => item.name === "chExt")?.attrs.get("cy") ?? 0,
  );
  // A missing or empty child extent means the group keeps an identity transform.
  const scaleX = childWidth > 0 ? position.width / childWidth : 1;
  const scaleY = childHeight > 0 ? position.height / childHeight : 1;
  return {
    ...position,
    childX: Number.isFinite(childX) ? childX : 0,
    childY: Number.isFinite(childY) ? childY : 0,
    scaleX,
    scaleY,
  };
}
