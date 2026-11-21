import type { ComputerUiAction } from "@pibot/protocol-base";
import { ComputerError } from "../core/errors.ts";
import type { ElementFacts } from "./tree.ts";

/** What the driver is actually asked to do for one ui_action. */
export interface UiStep {
  token: string;
  action: ComputerUiAction;
  /** The macOS AX action / attribute this ends up as, for refusal details. */
  ax?: string;
}

// Rows of tables, outlines and lists. macOS selects a row through AXSelected, not AXPick (rows
// list only AXShowDefaultUI / AXShowAlternateUI); Cua's press on a row does exactly that and
// confirms it by reading the selection back.
const ROW = /^AX(Outline)?Row$/;
// Menu bar and its menus belong to the app, not to the window the tree was read from: Cua
// refuses them in the background (element_outside_target_window), so the model is pointed at
// ui_action's menu form (invoke_menu by path) and the app's keyboard shortcuts instead.
const MENU = /^AXMenu(Bar|BarItem|Item)?$/;
// How far up from a cell / text inside a row a select may climb to find the row.
const ROW_SEARCH_DEPTH = 3;

// macOS roles are AX names; Windows (UIA) and Linux (AT-SPI) roles and actions are not.
const isAx = (facts: ElementFacts) => facts.role.startsWith("AX");
// An empty list (cells often report none) means "not reported", not "supports nothing".
const lists = (facts: ElementFacts) => facts.actions.length > 0;

function supported(facts: ElementFacts) {
  return facts.actions.length ? facts.actions.slice(0, 12).join(",") : "none";
}

function lacks(facts: ElementFacts, ax: string, hint?: string) {
  return new ComputerError(
    "unsupported",
    `element_lacks_${ax} supported=${supported(facts)}${hint ? ` ${hint}` : ""}`,
  );
}

function rowOf(known: Map<string, ElementFacts>, token: string, facts: ElementFacts) {
  let at: { token: string; facts: ElementFacts } | undefined = { token, facts };
  for (let i = 0; at && i <= ROW_SEARCH_DEPTH; i++) {
    if (ROW.test(at.facts.role)) return at.token;
    const parent: string | undefined = at.facts.parent;
    const parentFacts: ElementFacts | undefined = parent ? known.get(parent) : undefined;
    at = parent && parentFacts ? { token: parent, facts: parentFacts } : undefined;
  }
  return undefined;
}

/**
 * Turns the model's action into the driver step, refusing up front what the element's own
 * action list (macOS AX names from the last tree read) says cannot work — the owner's AXPick /
 * AXShowMenu on Notes rows failed with -25206 as an opaque driver_error. Other platforms name
 * actions differently, so their requests go through unchanged.
 */
export function planUiAction(
  known: Map<string, ElementFacts>,
  token: string,
  facts: ElementFacts,
  action: ComputerUiAction,
  value: string | undefined,
): UiStep {
  if (!isAx(facts)) return { token, action };
  switch (action) {
    case "showMenu":
      if (lists(facts) && !facts.actions.includes("AXShowMenu")) throw lacks(facts, "AXShowMenu");
      return { token, action, ax: "AXShowMenu" };
    case "select": {
      if (value !== undefined) return { token, action, ax: "AXValue" };
      if (facts.actions.includes("AXPick")) return { token, action, ax: "AXPick" };
      const row = rowOf(known, token, facts);
      if (row) return { token: row, action: "press", ax: "AXSelected" };
      if (lists(facts)) throw lacks(facts, "AXPick", "not_a_list_row_use_press_or_keys");
      return { token, action, ax: "AXPick" };
    }
    case "setValue":
      return { token, action, ax: "AXValue" };
    case "press":
    case "focus":
      // No early refusal: Cua presses rows (selection) and focuses text fields without AXPress.
      return { token, action, ax: "AXPress" };
    case "scrollTo":
      return { token, action };
  }
}

/** Driver refusals of one element action, re-worded with what that element does support. */
export function explainUiFailure(error: unknown, facts: ElementFacts, ax?: string): unknown {
  if (!(error instanceof ComputerError)) return error;
  const again = (code: ComputerError["code"], detail: string) =>
    new ComputerError(code, detail, error.diagnostic, undefined, undefined, error.disposition);
  if (error.detail === "element_outside_target_window" && MENU.test(facts.role))
    return again("unsupported", "menu_bar_use_keyboard_shortcut");
  if (error.detail === "element_action_unsupported")
    return again("unsupported", `element_lacks_${ax ?? "action"} supported=${supported(facts)}`);
  if (error.detail === "element_attribute_unsupported")
    return again(
      "unsupported",
      `element_value_not_settable supported=${supported(facts)} use_keys_to_type`,
    );
  return error;
}
