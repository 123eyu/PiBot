import type { Params, Payload, Result } from "@pibot/protocol-base";
import { SkillLinkEvents, SkillLinkMethods } from "./api/skill-links.ts";
import { SkillEvents, SkillMethods } from "./api/skills.ts";
import { TeachEvents, TeachMethods } from "./api/teach.ts";
import { WorkflowMethods } from "./api/workflows.ts";

export {
  type SkillCompatibilityEntry,
  SkillCompatibilityEntrySchema,
  type SkillCompatibilityReport,
  SkillCompatibilityReportSchema,
} from "@pibot/protocol-base";
export * from "./api/skills.ts";
export * from "./api/teach.ts";
export * from "./api/workflows.ts";

export const SkillsContractMethods = {
  ...SkillMethods,
  ...SkillLinkMethods,
  ...TeachMethods,
  ...WorkflowMethods,
} as const;
export const SkillsContractEvents = { ...SkillEvents, ...SkillLinkEvents, ...TeachEvents } as const;
export type SkillMethodParams = {
  [K in keyof typeof SkillsContractMethods]: Params<typeof SkillsContractMethods, K>;
};
export type SkillMethodResults = {
  [K in keyof typeof SkillsContractMethods]: Result<typeof SkillsContractMethods, K>;
};
export type SkillEventPayloads = {
  [K in keyof typeof SkillsContractEvents]: Payload<typeof SkillsContractEvents, K>;
};

export * from "./api/skill-links.ts";

export * from "./api/skill-reference.ts";
