import type { TranslationKey } from "@pibot/i18n";
import { RpcError, RpcErrorCodes, type TeachStep } from "@pibot/skills-contract/full";

type T = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** One recorded step as a sentence; values were already reduced to final text by brain. */
export function stepText(t: T, step: TeachStep) {
  const values = { target: step.target || "—", value: step.value ?? "" };
  switch (step.kind) {
    case "click":
      return step.value === "checked"
        ? t("teach.step.check", values)
        : step.value === "unchecked"
          ? t("teach.step.uncheck", values)
          : t("teach.step.click", values);
    case "type":
      return t(step.secret ? "teach.step.typeSecret" : "teach.step.type", values);
    default:
      return t(`teach.step.${step.kind}`, values);
  }
}

/** The site a step happened on, shown as a small tag (design: the "app" pill). */
export function stepSite(step: TeachStep) {
  try {
    return new URL(step.url).hostname;
  } catch {
    return "";
  }
}

export function elapsedText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function teachErrorKey(error: unknown): TranslationKey {
  if (!(error instanceof RpcError)) return "teach.error.failed";
  if (error.message === "teach_unfinished") return "teach.error.unfinished";
  if (error.code === RpcErrorCodes.busy) return "teach.error.busy";
  if (error.code === RpcErrorCodes.noModel) return "teach.error.noModel";
  switch (error.message) {
    case "teach_url_required":
    case "browser_unsupported_url":
      return "teach.error.url";
    case "browser_unavailable":
      return "teach.error.unavailable";
    case "teach_bot_unsupported":
      return "teach.error.imageBot";
    case "teach_draft_failed":
    case "teach_draft_unavailable":
      return "teach.error.draft";
    case "skill_name_exists":
      return "teach.error.nameExists";
    default:
      return "teach.error.failed";
  }
}
