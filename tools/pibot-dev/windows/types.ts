export const WINDOWS_CHECKS = ["first-screen", "backend-ready", "app-window"] as const;
export type WindowsCheck = (typeof WINDOWS_CHECKS)[number];
export interface WindowsStageReceipt {
  stage: string;
  outcome: "ok" | "failed" | "skipped" | "harness_failed";
  reason: string;
  durationMs: number;
  exitCode?: number | null;
}
export interface WindowsTestResult {
  outcome: WindowsStageReceipt["outcome"];
  detail: string;
  log: string;
  runId: string;
  sourceDigest?: string;
  artifactHash?: string;
  arch: "x64";
  stages: WindowsStageReceipt[];
}
export interface WindowsTestOptions {
  signal?: AbortSignal;
  sourceDigest?: string;
  checks?: readonly WindowsCheck[];
}
export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  stopped?: "cancelled" | "timeout" | "output_limit";
  drained: boolean;
  out: string;
}
export interface CommandOptions {
  signal: AbortSignal;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
