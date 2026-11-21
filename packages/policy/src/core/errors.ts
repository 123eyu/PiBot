/** A rejected external path/URL is different from an implementation bug. */
export class PolicyInputError extends Error {}

/** Stable checks for rejected target facts; never a filesystem or URL exception message. */
export class PolicyTargetError extends PolicyInputError {
  constructor(
    readonly check:
      | "path_resolution_failed"
      | "url_resolution_failed"
      | "target_realpath_unavailable",
  ) {
    super(check);
  }
}
