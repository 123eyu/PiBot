import type { ComputerFailureCode } from "@pibot/protocol-base";
import { ComputerError, scrubDriverText } from "../core/errors.ts";

/** Tool error codes from Cua that mean "the element token is from an older snapshot". */
const STALE = /stale|superseded|unknown_element|element_token/i;
const BACKGROUND_REFUSED =
  /background.*(?:unavailable|unsupported)|off_space|requires_foreground|foreground/i;
const PERMISSION = /permission|not_trusted|accessibility|screen_recording|tcc/i;
// get_window_state produced neither a tree nor a picture: the window is minimised, hidden
// behind a full-screen app / on another Space, or still being created.
const NO_CONTENT = /no content produced/i;
// Cua's element token was resolved but the element sits outside the window it was read from:
// menu bar items and open menus belong to the app, sheets / popovers to another window.
const OUTSIDE_WINDOW = /element_outside_target_window/i;
// macOS AXError numbers Cua quotes in "AX action failed: …(AXPick) returned -25206" and
// "set_value failed: …(AXValue) failed with error -25205" (owner's Notes rows).
const AX_ERROR = /(?:returned|error)\s+(-252\d\d)\b/;
const AX_ERRORS: Record<string, [ComputerFailureCode, string]> = {
  // kAXErrorActionUnsupported / kAXErrorNotImplemented: the element lacks that action.
  "-25206": ["unsupported", "element_action_unsupported"],
  "-25208": ["unsupported", "element_action_unsupported"],
  // kAXErrorAttributeUnsupported / ParameterizedAttributeUnsupported: e.g. no settable AXValue.
  "-25205": ["unsupported", "element_attribute_unsupported"],
  "-25213": ["unsupported", "element_attribute_unsupported"],
  // kAXErrorInvalidUIElement: the element is gone (list re-rendered, window closed).
  "-25202": ["stale_element", "element_gone_read_ui_tree_again"],
  // kAXErrorCannotComplete: the app did not answer (busy, beachballing, or quitting).
  "-25204": ["timeout", "app_not_responding_ax_cannot_complete"],
  // kAXErrorAPIDisabled: Accessibility is off for Pi Bot.
  "-25211": ["permission_missing", "accessibility"],
};

/**
 * The labels Cua lists after a menu path miss ('… was not found under "View". Items there:
 * "Basic", "Scientific"'). Unparseable entries are skipped: the model then only loses the hint.
 */
function menuChoices(text: string): string[] {
  const at = text.indexOf("Items there:");
  if (at < 0) return [];
  const choices: string[] = [];
  for (const m of text.slice(at).matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const label = (JSON.parse(`"${m[1]}"`) as string).trim();
      if (label) choices.push(label.slice(0, 100));
    } catch {
      // An escape JSON does not know; leave that label out of the hint.
    }
    if (choices.length >= 40) break;
  }
  return choices;
}

/**
 * invoke_menu refusals (Cua 0.35.2 texts, invoke-menu probe on Calculator). Undefined = not
 * a menu-specific case; the generic mapping (AX errors, permissions, …) applies.
 */
function menuError(code: string, text: string, diagnostic?: string): ComputerError | undefined {
  if (!text.startsWith("invoke_menu:")) return undefined;
  const segment = /path segment (\d+)/.exec(text)?.[1];
  const at = segment === undefined ? "" : ` at=${Number(segment) + 1}`;
  if (/was not found/.test(text))
    return new ComputerError(
      "unsupported",
      `menu_item_not_found${at}`,
      diagnostic,
      menuChoices(text),
    );
  // macOS validates most items against the key window, which a background app does not have:
  // they read as disabled until the app is in front (Cua: "disabled while … in the background").
  if (/is disabled/.test(text))
    return BACKGROUND_REFUSED.test(code) || /background/.test(text)
      ? new ComputerError("needs_foreground", `menu_item_disabled_in_background${at}`, diagnostic)
      : new ComputerError("unsupported", `menu_item_disabled${at}`, diagnostic);
  if (/ambiguous/i.test(text))
    return new ComputerError("unsupported", `menu_item_ambiguous${at}`, diagnostic);
  if (/no usable native menu action/.test(text))
    return new ComputerError("unsupported", "menu_item_not_invokable", diagnostic);
  if (/window_id|target window/.test(text))
    return new ComputerError("window_not_found", "menu_window_gone", diagnostic);
  return undefined;
}

/**
 * Cua's refusal → Pi Bot's code. Only Cua's code (never its text, which can quote window
 * contents) goes to the model; `diagnostic` (scrubbed) is for the host log.
 */
export function toComputerError(
  code: string | undefined,
  text: string,
  diagnostic?: string,
): ComputerError {
  const c = code ?? "";
  const as = (to: ConstructorParameters<typeof ComputerError>[0], detail: string) =>
    new ComputerError(to, detail, diagnostic);
  const menu = menuError(c, text, diagnostic);
  if (menu) return menu;
  if (OUTSIDE_WINDOW.test(c)) return as("stale_element", "element_outside_target_window");
  const ax = AX_ERROR.exec(text)?.[1];
  const axMapped = ax ? AX_ERRORS[ax] : undefined;
  if (axMapped) return as(axMapped[0], axMapped[1]);
  if (STALE.test(c)) return as("stale_element", c);
  if (BACKGROUND_REFUSED.test(c) || c === "select_menu_would_raise_window")
    return as("needs_foreground", "background_unsupported");
  if (PERMISSION.test(c)) return as("permission_missing", c);
  if (/window/.test(c)) return as("window_not_found", c);
  if (NO_CONTENT.test(text)) return as("window_not_found", "window_not_capturable");
  if (!c && PERMISSION.test(text)) return as("permission_missing", "tool_error");
  return as("driver_error", c || (text ? "tool_error" : "unknown"));
}

/**
 * A thrown Cua SDK error: uniffi `DriverError` with `tag` (Tool / Worker / Transport / …) and
 * `inner.errorCode`, `inner.message | reason`. Reading only `error.name` (always "Error") made
 * every thrown failure — e.g. a screenshot of a minimised window — an opaque driver_error.
 */
export function fromThrown(error: unknown): ComputerError {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    tag?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
    inner?: { errorCode?: unknown; message?: unknown; reason?: unknown };
  };
  const tag = typeof e.tag === "string" ? e.tag : undefined;
  const code =
    typeof e.inner?.errorCode === "string" && e.inner.errorCode
      ? e.inner.errorCode
      : typeof e.code === "string" || typeof e.code === "number"
        ? String(e.code)
        : undefined;
  const text =
    [e.inner?.message, e.inner?.reason, e.message].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    ) ?? "";
  const kind = tag ?? (typeof e.name === "string" ? e.name : "unknown");
  const diagnostic = `cua ${kind}${code ? `/${code}` : ""}: ${scrubDriverText(text)}`;
  if (tag === "Tool" || code) return toComputerError(code, text, diagnostic);
  // The SDK's worker / transport / shutdown, or a plain JS error: name the kind only.
  return new ComputerError(
    "driver_error",
    (tag ? `cua_${tag.toLowerCase()}` : kind).slice(0, 60),
    diagnostic,
  );
}
