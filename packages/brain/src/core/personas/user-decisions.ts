import { userDecisionsPrompts } from "./prompts/user-decisions.ts";
export function userDecisionRule(language: "zh" | "en") {
  return userDecisionsPrompts.userDecisionRule[language];
}
