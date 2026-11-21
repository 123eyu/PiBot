import { z } from "zod";

/** Only compiled-in system services may report these fixed codes across MCP. */
export const ConnectorNativeFailureSchema = z.enum([
  "outlook_missing",
  "outlook_access_denied",
  "native_app_failed",
  "permission_required",
  "dependency_missing",
  "unsupported_platform",
]);
export type ConnectorNativeFailure = z.infer<typeof ConnectorNativeFailureSchema>;
export const CONNECTOR_NATIVE_FAILURE_META = "pibot/nativeFailure";

export const ConnectorNativeDiagnosticsSchema = z.strictObject({
  status: z.number().int().min(0).max(4).nullable(),
  containerCount: z.number().int().min(0).max(2_147_483_647).nullable(),
});
export type ConnectorNativeDiagnostics = z.infer<typeof ConnectorNativeDiagnosticsSchema>;
export const CONNECTOR_NATIVE_DIAGNOSTICS_META = "pibot/nativeDiagnostics";
/** Accept only fixed numeric diagnostics; never project container names, accounts or text. */
export function connectorNativeDiagnostics(value: unknown): ConnectorNativeDiagnostics | undefined {
  const parsed = ConnectorNativeDiagnosticsSchema.safeParse(
    value && typeof value === "object" && "nativeDiagnostics" in value
      ? value.nativeDiagnostics
      : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

export class ConnectorNativeError extends Error {
  readonly failureCode: ConnectorNativeFailure;
  readonly nativeDiagnostics?: ConnectorNativeDiagnostics;
  constructor(failureCode: ConnectorNativeFailure, nativeDiagnostics?: ConnectorNativeDiagnostics) {
    super(failureCode);
    this.failureCode = failureCode;
    this.nativeDiagnostics = nativeDiagnostics;
    this.name = "ConnectorNativeError";
  }
}

/** Call failures do not change the connector's startup/lifecycle failure vocabulary. */
export const ConnectorNativeCallFailureSchema = z.union([
  ConnectorNativeFailureSchema,
  z.enum(["read_failed", "contact_scan_limit", "contacts_unavailable"]),
]);
export type ConnectorNativeCallFailure = z.infer<typeof ConnectorNativeCallFailureSchema>;
export class ConnectorNativeCallError extends Error {
  readonly failureCode: ConnectorNativeCallFailure;
  readonly nativeDiagnostics?: ConnectorNativeDiagnostics;
  constructor(
    failureCode: ConnectorNativeCallFailure,
    nativeDiagnostics?: ConnectorNativeDiagnostics,
  ) {
    super(failureCode);
    this.failureCode = failureCode;
    this.nativeDiagnostics = nativeDiagnostics;
    this.name = "ConnectorNativeCallError";
  }
}
