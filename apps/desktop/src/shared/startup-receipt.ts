/** Cache deletion is a user-visible operation: every non-success reply fails closed. */
export function assertStartupCacheCleared(value: unknown): void {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true)
    throw new Error("startup_cache_clear_failed");
}
