import type { createTranslator } from "@pibot/i18n";
import type { GrantListItem } from "@pibot/protocol";

export function topicGrantLabel(grant: GrantListItem, t: ReturnType<typeof createTranslator>) {
  const scope = grant.scope;
  if ((scope.kind !== "programs" && scope.kind !== "workplace") || !scope.topicId) return;
  const place = grant.topicWorkplace;
  const topic = place?.title ? `${place.title} (${scope.topicId})` : scope.topicId;
  const roots = !place?.available
    ? t("permissions.topicGrantUnavailable")
    : place.writeRoots.length
      ? place.writeRoots.join(", ")
      : t("permissions.topicGrantNoRoots");
  const label = t("permissions.topicGrantScope", { topic, roots });
  return scope.kind === "programs" ? `${scope.programs.join(", ")} · ${label}` : label;
}
