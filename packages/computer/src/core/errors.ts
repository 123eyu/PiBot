import type {
  ComputerFailure,
  ComputerFailureCode,
  ComputerFailureDisposition,
} from "@pibot/protocol-base";

/**
 * Refusals that happen before anything reached the app. Retrying them is safe
 * once the detail's hint is handled (read the tree again, grant the app, …).
 */
const BEFORE_DELIVERY: ReadonlySet<ComputerFailureCode> = new Set([
  "grant_invalid",
  "grant_expired",
  "app_not_granted",
  "app_blocked",
  "coordinates_not_allowed",
  "needs_foreground",
  "screen_locked",
  "secure_field",
  "secure_scan_incomplete",
  "stale_element",
  "app_not_running",
  "window_not_found",
  "permission_missing",
  "unsupported",
]);

/**
 * The disposition when the error site did not say: everything that is not a before-delivery
 * refusal may already have reached the app. `cancelled` lands here too — aborting a call does
 * not prove the driver never injected its input.
 */
export function defaultDisposition(code: ComputerFailureCode): ComputerFailureDisposition {
  return BEFORE_DELIVERY.has(code)
    ? { delivered: "no", retry: "safe" }
    : { delivered: "unknown", retry: "after_check" };
}

/**
 * Overrides the code default for an error point that knows the input never left this process,
 * even though its code (e.g. target_moved after a window check) would say otherwise.
 */
export function notDelivered(
  code: ComputerFailureCode,
  detail?: string,
  diagnostic?: string,
): ComputerError {
  return new ComputerError(code, detail, diagnostic, undefined, undefined, {
    delivered: "no",
    retry: "safe",
  });
}

/** Overrides the default for a failure after the driver was handed the input (timeout, …). */
export function deliveryUnknown(
  code: ComputerFailureCode,
  detail?: string,
  diagnostic?: string,
): ComputerError {
  return new ComputerError(code, detail, diagnostic, undefined, undefined, {
    delivered: "unknown",
    retry: "after_check",
  });
}

/**
 * An expected refusal or failure of a driver step. The service turns it into a
 * `{ ok: false, code }` result so the model learns why; anything else is a bug and
 * becomes `driver_error` after being logged.
 */
export class ComputerError extends Error {
  readonly code: ComputerFailureCode;
  /** Machine-oriented hint; never screen text, file contents or secrets. */
  readonly detail?: string;
  /**
   * What the driver itself said (its error kind / code and a scrubbed message), for the host
   * log only: it never reaches the model, because a driver message may name a window.
   */
  readonly diagnostic?: string;
  /** The app's menu titles where a menu path stopped matching (to the model, not logs). */
  readonly choices?: string[];
  constructor(
    code: ComputerFailureCode,
    detail?: string,
    diagnostic?: string,
    choices?: string[],
    readonly recovery?: Pick<ComputerFailure, "windows" | "focusTargets">,
    /** Set where the error site knows whether its input reached the app. */
    readonly disposition?: ComputerFailureDisposition,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ComputerError";
    this.code = code;
    this.detail = detail;
    this.diagnostic = diagnostic;
    this.choices = choices;
  }
}

/**
 * Driver / error text made fit for a log line: quoted parts (where drivers put window titles,
 * element names and values) are dropped, control characters removed, length capped.
 */
export function scrubDriverText(text: string, max = 200): string {
  return text
    .replace(/["'`\u201c\u2018\u300c][^"'`\u201d\u2019\u300d]*["'`\u201d\u2019\u300d]/g, "…")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function failure(error: unknown): ComputerFailure | undefined {
  if (!(error instanceof ComputerError)) return undefined;
  const choices = error.choices?.slice(0, 40).map((c) => c.slice(0, 100));
  return {
    ok: false,
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail.slice(0, 500) }),
    disposition: error.disposition ?? defaultDisposition(error.code),
    ...(choices?.length ? { choices } : {}),
    ...(error.recovery?.windows
      ? {
          windows: error.recovery.windows
            .slice(0, 20)
            .map((w) => ({ id: w.id.slice(0, 200), title: w.title.slice(0, 200) })),
        }
      : {}),
    ...(error.recovery?.focusTargets
      ? {
          focusTargets: error.recovery.focusTargets
            .filter((id) => id.length > 0 && id.length <= 512)
            .slice(0, 8),
        }
      : {}),
  };
}

export const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/**
 * Bounds one driver call: rejects with `timeout` after `ms`, or `cancelled` when `signal`
 * aborts. The underlying operation receives a signal that fires in both cases so native
 * calls that honour AbortSignal can stop early.
 */
export async function bounded<T>(
  what: string,
  ms: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new ComputerError("cancelled", what);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ComputerError("timeout", what));
    }, ms);
    onAbort = () => {
      controller.abort();
      reject(new ComputerError("cancelled", what));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
