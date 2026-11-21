// Strict-mode providers make models fill every optional field (2026-11-21, gpt-6.1-sol: keys with
// text " " next to combo; ui_action "select" carrying a made-up path and a copy of itself in
// actions). Every such call failed validation, so computer use was unusable. Before validation,
// fields that carry nothing are dropped: null, blank strings, empty arrays, and for ui_action the
// fields the named `action` never reads. `action` is required and says which form the call takes,
// so nothing is guessed; the strict schema still checks the result, policy sees the normalised
// call, and two meaningful values for one choice (keys text + combo) still fail.

type Args = Record<string, unknown>;

const empty = (value: unknown) =>
  value === null ||
  (typeof value === "string" && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

const absent = (value: unknown) => typeof value === "string" && !value.trim();

function without(args: Args, drop: (key: string, value: unknown) => boolean): Args {
  let changed = false;
  const kept: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (drop(key, value)) changed = true;
    else kept[key] = value;
  }
  return changed ? kept : args;
}

/** A blank value means nothing except to setValue, where "" clears the field. */
function elementStep(step: unknown): unknown {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  const action = (step as Args).action;
  return without(
    step as Args,
    (key, value) => value === null || (key === "value" && action !== "setValue" && absent(value)),
  );
}

const UI_ACTION_FIELDS: Record<"batch" | "menu" | "element", ReadonlySet<string>> = {
  batch: new Set(["elementId", "path", "value"]),
  menu: new Set(["elementId", "value", "actions"]),
  element: new Set(["path", "actions"]),
};

function normalizeUiAction(args: Args): Args {
  const action = args.action;
  if (typeof action !== "string") return args;
  const form = action === "batch" ? "batch" : action === "menu" ? "menu" : "element";
  const unused = UI_ACTION_FIELDS[form];
  const trimmed = without(args, (key, value) => {
    if (unused.has(key)) return true;
    // Only element actions get this far with a value (the other forms never read it).
    if (key === "value") return value === null || (action !== "setValue" && absent(value));
    return key !== "app" && key !== "action" && empty(value);
  });
  return form === "batch" && Array.isArray(trimmed.actions)
    ? { ...trimmed, actions: trimmed.actions.map(elementStep) }
    : trimmed;
}

function normalizeKeys(args: Args): Args {
  const combo = Array.isArray(args.combo) && args.combo.length > 0;
  return without(args, (key, value) => {
    if (key === "app") return false;
    // Whitespace typed next to a shortcut is filler; on its own it is a real space to type.
    if (key === "text") return value === null || value === "" || (combo && !String(value).trim());
    if (key === "combo") return value === null || (Array.isArray(value) && !value.length);
    return empty(value);
  });
}

/**
 * `kind` says which fields a pointer step reads: only a drag has a destination and only a scroll
 * has dx / dy. A padded `to: {x: 0, y: 0}` on a click made the foreground driver check a drag
 * destination at the screen corner and refuse every right-click as occluded.
 */
function normalizePointer(args: Args): Args {
  const kind = args.kind;
  if (typeof kind !== "string") return args;
  return without(args, (key, value) => {
    if (key === "to") return kind !== "drag" || value === null;
    if (key === "dx" || key === "dy") return kind !== "scroll" || value === null;
    return key !== "app" && key !== "kind" && value === null;
  });
}

/** Drops placeholder fields from keys / ui_action / pointer arguments; other tools pass through. */
export function normalizeComputerInput(tool: string, input: unknown): unknown {
  if (tool !== "keys" && tool !== "ui_action" && tool !== "pointer") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (tool === "pointer") return normalizePointer(input as Args);
  return tool === "keys" ? normalizeKeys(input as Args) : normalizeUiAction(input as Args);
}
