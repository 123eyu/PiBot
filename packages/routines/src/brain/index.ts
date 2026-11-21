/**
 * Routines, brain entry: `routinesCapability` registers scheduling,
 * execution of unattended runs, proposals, the inbox kinds and the `routines.*` RPC with the
 * kernel through its capability context.
 */
export { routinesCapability } from "./capability.ts";
export type { RoutineDevAdapter } from "./dev/dev.ts";
export type { RoutineHostAdapter } from "./host-adapter.ts";
