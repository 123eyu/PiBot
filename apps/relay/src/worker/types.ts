export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}
export interface RelayEnv {
  ROOMS: DurableObjectNamespace;
  CONNECTION_LIMITER?: RateLimitBinding;
  PUSH_LIMITER?: RateLimitBinding;
  EXPO_ACCESS_TOKEN?: string;
  /** Aggregate connection counts; absent in the in-memory test environment. */
  STATS?: DurableObjectNamespace;
  STATS_TOKEN?: string;
}
