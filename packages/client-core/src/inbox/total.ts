import type { MethodResults } from "@pibot/protocol";

/**
 * One definition of "how many things wait for the user", shared by every badge and the inbox
 * page. A pending send draft also has a pending approval row, so `draft` is a subset of
 * `approval` and must not be added again.
 */
export function inboxTotal(counts: MethodResults["inbox.counts"]): number {
  return Object.entries(counts).reduce(
    (sum, [key, count]) => sum + (key === "draft" ? 0 : (count ?? 0)),
    0,
  );
}
