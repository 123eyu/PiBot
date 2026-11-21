import type { PptOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { applyShapeOperation } from "./edit-shapes.ts";
import { applySlideOperation, isSlideOperation } from "./edit-slides.ts";

export async function applyPptOperation(pkg: OfficePackage, operation: PptOperation) {
  if (isSlideOperation(operation)) await applySlideOperation(pkg, operation);
  else applyShapeOperation(pkg, operation);
}
