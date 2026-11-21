import type { Bot } from "@pibot/protocol-base";
import { artifactCreationMethod } from "./artifact-detail.ts";
import { workQualityPrompts } from "./prompts/work-quality.ts";

type Language = "zh" | "en";
type Direction =
  | "engineering"
  | "visual"
  | "interaction"
  | "review"
  | "qa"
  | "operations"
  | "research"
  | "data"
  | "content"
  | "script"
  | "publishing"
  | "translation"
  | "documentation"
  | "tutoring"
  | "product"
  | "coordination"
  | "office"
  | "recruiting"
  | "general";
const directions: Record<string, Direction> = {
  "frontend-dev": "engineering",
  "backend-dev": "engineering",
  "fullstack-dev": "engineering",
  "ui-ux-designer": "interaction",
  "image-designer": "visual",
  "video-scriptwriter": "script",
  "code-reviewer": "review",
  "qa-engineer": "qa",
  devops: "operations",
  researcher: "research",
  "data-analyst": "data",
  copywriter: "content",
  "social-media": "publishing",
  translator: "translation",
  "tech-writer": "documentation",
  tutor: "tutoring",
  "product-manager": "product",
  "project-manager": "coordination",
  "personal-assistant": "office",
  recruiter: "recruiting",
  "general-assistant": "general",
};
const criteria: Record<Direction, Record<Language, string>> = workQualityPrompts.criteria;

export function directionCriteria(roleId: string | undefined, language: Language) {
  const direction = roleId && directions[roleId];
  return direction ? criteria[direction][language] : "";
}

/**
 * The delivery path, file naming and GB/T 7714 rules were copied verbatim into the
 * researcher, data-analyst and general-assistant norms. Keeping them here reaches existing and
 * custom Bots too, and leaves the role norms for role-specific guidance. The citation rule is
 * limited to research and data: a general assistant does not default to cited reports.
 */
const deliveryDirections = new Set<Direction>(["research", "data", "general"]);
const citationDirections = new Set<Direction>(["research", "data"]);

function deliveryRule(roleId: string | undefined, language: Language) {
  const direction = roleId ? directions[roleId] : undefined;
  const documentRule = workQualityPrompts.deliveryRule.documentRule[language];
  // Models explained a root cause and stopped; the request was to change the work, so the
  // acting requirement is fixed text appended after the existing rules (stable prefix for caching).
  const actingRule = workQualityPrompts.deliveryRule.actingRule[language];
  if (!direction || !deliveryDirections.has(direction)) return `${documentRule} ${actingRule}`;
  const standard = workQualityPrompts.deliveryRule.standard[language];
  return `${documentRule} ${standard} ${actingRule}`;
}

function citationRule(roleId: string | undefined, language: Language) {
  const direction = roleId ? directions[roleId] : undefined;
  if (!direction || !citationDirections.has(direction)) return "";
  return workQualityPrompts.citationRule[language];
}

/** Runtime guidance reaches existing/custom Bots without overwriting their saved persona or norms. */
export function workQualityPrompt(bot: Pick<Bot, "role">, language: Language, canCreate = false) {
  const common = workQualityPrompts.common[language];
  return [
    common,
    directionCriteria(bot.role?.id, language),
    deliveryRule(bot.role?.id, language),
    citationRule(bot.role?.id, language),
    canCreate ? artifactCreationMethod(language) : "",
  ]
    .filter(Boolean)
    .join("\n");
}
