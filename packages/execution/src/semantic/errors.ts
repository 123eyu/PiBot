/**
 * A failed code navigation used to reach brain as a bare `tool_failed`. These fixed codes
 * are what a model and a log line can act on, and they never carry a path or source text.
 */
export type SemanticFailure =
  | "timeout"
  | "cancelled"
  | "busy"
  | "worker_exit"
  | "worker_error"
  | "too_large"
  | "invalid_input"
  | "unavailable"
  | "unsupported_language"
  // An outline of one file has to say which refusal it hit; "unsupported_language" for a
  // file the reader rejected for its size or bytes sent the model to the wrong fix.
  | "file_too_large"
  | "not_utf8"
  | "file_unreadable"
  | "file_changed"
  | "not_parsed";

export class SemanticError extends Error {
  constructor(
    readonly code: SemanticFailure,
    /** Legacy `semantic_*` messages stay for log filters that already match them. */
    message: string = code,
    /** How the worker failed (class name / own code / exit code); never source text. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SemanticError";
  }
}
