import { ExecError } from "../core/types.ts";

/** Fixed diagnostics: no object bytes, config text or model values are embedded. */
export class GitOutputSourceError extends ExecError {
  constructor(readonly scope: "object_limit" | "object_layout") {
    super(scope === "object_limit" ? "isolation_scan_limit" : "invalid_input");
  }
}
