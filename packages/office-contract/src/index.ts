import type { Params, Result } from "@pibot/protocol-base";
import type { OfficeMethods } from "./api/methods.ts";

export type {
  OfficeChangeItem,
  OfficeChangeKind,
  OfficeChanges,
  OfficeLocator,
  OfficeStructureItem,
  OfficeStructurePage,
  OfficeStructureQuery,
  OfficeTextOperation,
  OfficeValidation,
  PresentationLayoutId,
  PresentationLayouts,
  PresentationObject,
  PresentationTemplate,
  PresentationThemeId,
} from "@pibot/protocol-base";
export {
  OfficeLocatorSchema,
  OfficePresentationLayoutSchema,
  OfficePresentationLayoutsSchema,
  OfficePresentationObjectSchema,
  OfficePresentationTemplateSchema,
  OfficePresentationThemeSchema,
  OfficeStructureItemSchema,
  OfficeStructureKindSchema,
  OfficeStructurePageSchema,
  OfficeStructureQuerySchema,
  OfficeTextOperationsSchema,
  OfficeValidationSchema,
} from "@pibot/protocol-base";
export * from "./api/compare.ts";
export * from "./api/methods.ts";
export * from "./tools/descriptions.ts";
export type OfficeMethodParams = {
  [K in keyof typeof OfficeMethods]: Params<typeof OfficeMethods, K>;
};
export type OfficeMethodResults = {
  [K in keyof typeof OfficeMethods]: Result<typeof OfficeMethods, K>;
};

export type { ExcelOperation, ExcelStyle, OfficeOperation } from "@pibot/protocol-base";
export {
  ExcelOperationSchema,
  ExcelStyleSchema,
  OfficeOperationsSchema,
} from "@pibot/protocol-base";

export * from "./endpoints/catalog.ts";
