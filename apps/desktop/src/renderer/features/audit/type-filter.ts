import { auditFilters, auditKinds, auditMatches } from "@pibot/client-core";
import type { AuditCountBucket } from "@pibot/protocol";

export const activityTypes = [...auditFilters, "computer", "background"] as const;
export type ActivityType = (typeof activityTypes)[number];
const key = "pibot.audit.type.v1";
export function isActivityType(value: unknown): value is ActivityType {
  return activityTypes.some((type) => type === value);
}
export function readActivityType(): ActivityType {
  try {
    const value = localStorage.getItem(key);
    return isActivityType(value) ? value : "all";
  } catch {
    // A blocked local preference cache must not prevent opening the records page.
    return "all";
  }
}
export function saveActivityType(value: ActivityType) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // This preference is optional and local; do not fall back to synced brain settings.
  }
}
export function activityTypeCounts(
  buckets: AuditCountBucket[],
  routineRuns: number,
  showInternal: boolean,
): Record<ActivityType, number> {
  const counts = Object.fromEntries(activityTypes.map((type) => [type, 0])) as Record<
    ActivityType,
    number
  >;
  for (const bucket of buckets) {
    if (bucket.source !== "audit") {
      counts[bucket.source] += bucket.count;
      continue;
    }
    if (!bucket.kind) continue;
    const entry = {
      kind: bucket.kind,
      summary: "",
      detail: {
        internal: bucket.internal,
        ...(bucket.category ? { category: bucket.category } : {}),
      },
    };
    for (const filter of auditFilters) {
      const kinds = auditKinds(filter);
      // Same two steps as the pager: its kind streams first, then the single group projection.
      // The kind prefilter also keeps category-dependent groups (denied send) on one side.
      if (
        (kinds.includes(undefined) || kinds.includes(bucket.kind)) &&
        auditMatches(entry, filter, showInternal)
      )
        counts[filter] += bucket.count;
    }
  }
  counts.all += routineRuns;
  counts.scheduling += routineRuns;
  return counts;
}
