import { AgentError } from "../core/errors.ts";

/** Reject before SDK credential resolution can select its subscription compatibility path. */
export function assertSupportedCredential(value: string | undefined): void {
  if (value && /sk-ant-oat/i.test(value)) throw new AgentError("claude_subscription_unsupported");
}

export function assertSupportedHeaders(headers?: Record<string, string>): void {
  for (const value of Object.values(headers ?? {})) assertSupportedCredential(value);
}
