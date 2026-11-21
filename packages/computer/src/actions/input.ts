import type { HostComputerParams, HostComputerResults } from "@pibot/protocol-base";
import {
  type Call,
  forgetWindows,
  resolveApp,
  resolveWindow,
  type ServiceContext,
  windowKey,
  windowsOf,
} from "../core/context.ts";
import { ComputerError, notDelivered } from "../core/errors.ts";
import type { Point, Rect, WindowInfo } from "../core/types.ts";
import { menuPathRefusal } from "../guard/blocklist.ts";
import { assertAppShortcut, assertFrontmost, isNonTextShortcut } from "../guard/foreground.ts";
import { focusValue } from "./focus-value.ts";
import { inside, toGlobal } from "./frames.ts";
import { type Identified, verifyAtActionTime } from "./reidentify.ts";
import { confirmUnscannedInput, invalidateSecureScans } from "./secure-input.ts";
import type { ElementFacts } from "./tree.ts";
import { DEFAULT_TREE_LIMITS, readWindow } from "./tree-read.ts";
import { explainUiFailure, planUiAction } from "./ui-plan.ts";

type P<K extends keyof HostComputerParams> = HostComputerParams[K];
type R<K extends keyof HostComputerResults> = HostComputerResults[K];

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function contains(rect: Rect, point: Point) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

/**
 * The element's identity as the model was last shown it: from the newest read when the token is
 * still there, otherwise from the ledger of tokens `ui_tree` issued. A token stays valid until
 * the element itself changes — internal reads must not consume it.
 */
function snapshotted(
  ctx: ServiceContext,
  window: WindowInfo,
  elementId: string,
): { expected: Identified; known: Map<string, ElementFacts> } | undefined {
  const snapshot = ctx.elements.get(windowKey(window));
  const known = snapshot?.facts ?? new Map<string, ElementFacts>();
  const facts = known.get(elementId) ?? snapshot?.issued?.get(elementId);
  if (!facts) return undefined;
  return { expected: { token: elementId, facts }, known };
}

/**
 * The element to act on, checked against a tree read taken right now. Cua resolves a token to
 * whatever occupies that element's place when the action runs, so a list that reordered between
 * the model's read and its click used to click the neighbour. The fresh read
 * re-identifies the element by role, label and ancestors and returns the token it holds now; an
 * element that is gone or cannot be told apart stops the action instead of guessing, which is
 * also how the driver-side check is done (Cua 0.38.0 action receipts carry no
 * element facts, so the comparison has to happen against a read).
 *
 * The read runs through `readWindow`, so the password-field marks and the secure-scan state the
 * action relies on come from the same tree it verified against.
 */
async function factsFor(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  elementId: string,
): Promise<Identified & { known: Map<string, ElementFacts> }> {
  if (elementId.startsWith("#")) throw notDelivered("driver_error", "element_not_actionable");
  const snapshot = ctx.elements.get(windowKey(window));
  const found = snapshotted(ctx, window, elementId);
  if (!found) throw new ComputerError("stale_element", "read_ui_tree_again");
  const fresh = await readWindow(ctx, call, window, snapshot?.limits ?? DEFAULT_TREE_LIMITS);
  const verified = verifyAtActionTime(found.expected.facts, fresh.mapped.facts);
  // The interface changed while the model was deciding: say so instead of acting on a token that
  // now means another element. Nothing has been sent yet.
  if (!verified) throw new ComputerError("stale_element", "element_changed_read_ui_tree_again");
  return { ...verified, known: fresh.mapped.facts };
}

async function refuseSecure(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  facts: ElementFacts | undefined,
  options: { requireProof?: boolean; pick?: boolean } = {},
) {
  if (facts?.secure) throw new ComputerError("secure_field");
  // Second opinion from the OS (macOS AX subrole, Windows UIAutomation IsPassword plus the
  // Win32 edit style) in case the driver's role hid the type. The window id lets Windows
  // reject focus that sits in another window of the same app.
  const at = facts?.frame ? center(facts.frame) : undefined;
  const secure = await ctx.driver.secureFocus(window.pid, at, call.signal, window.id);
  if (secure === true) throw new ComputerError("secure_field");
  // Selecting an item does not type; a point on a non-text control must not block it.
  if (options.pick) return secure;
  if (secure === "occluded") {
    // The point belongs to whatever covers the window, so it can say nothing about the target.
    // Ask about the element itself instead: its own accessibility element and control
    // handle still answer while it is covered, which keeps background input into a plain text
    // box working. A field we cannot prove is not a password field keeps the refusal.
    const byElement = await elementProof(ctx, call, window, facts);
    if (byElement === false) return false;
    throw new ComputerError("unsupported", "focus_check_occluded_bring_window_to_front");
  }
  // Windows' tree reports password edits as plain Edit, so an element target is not evidence
  // there: an inconclusive OS answer must refuse instead of letting the input through.
  if (options.requireProof && secure !== false)
    throw new ComputerError("unsupported", "focus_check_unavailable_use_elementId");
  return secure;
}

/**
 * What the element itself says, for a window no point can judge: the driver identifies the
 * control the tree reported (its UIA element, its own HWND) and reads IsPassword and the Win32
 * edit style from that, never from a position on the screen. Anything short of a proven "not a
 * password field" stays "unknown" so the caller refuses.
 */
async function elementProof(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  facts: ElementFacts | undefined,
): Promise<boolean | "unknown"> {
  // Without a frame there is nothing to identify, and only Windows can ask this way.
  if (!ctx.driver.secureElement || !facts?.frame) return "unknown";
  const answer = await ctx.driver.secureElement(window, facts.frame, call.signal);
  if (answer === true) throw new ComputerError("secure_field");
  return answer;
}

type MenuParams = Extract<P<"host.computer.uiAction">, { action: "menu" }>;

/**
 * An app menu item by path. Same app checks as element actions (blocklist, grant, the
 * privacy window) plus the menus that reach beyond the app (menuPathRefusal).
 */
async function menuAction(ctx: ServiceContext, call: Call, p: MenuParams) {
  const app = await resolveApp(ctx, call, p.app);
  const refusal = menuPathRefusal(app, p.path);
  if (refusal) throw new ComputerError(refusal.code, refusal.detail);
  const window = await resolveWindow(ctx, call, app, p.window);
  const delivery = p.delivery ?? "auto";
  if (delivery === "foreground" && (await ctx.driver.session(call.signal)).locked)
    throw new ComputerError("screen_locked");
  const done = await ctx.driver.invokeMenu(window, p.path, delivery, call.signal);
  // A menu command can open or close windows; the next resolution must see that.
  forgetWindows(ctx, window.pid);
  return { ok: true, ...done } satisfies R<"host.computer.uiAction">;
}

export async function uiAction(
  ctx: ServiceContext,
  call: Call,
  p: Exclude<P<"host.computer.uiAction">, { action: "batch" }>,
  pinned?: WindowInfo,
) {
  invalidateSecureScans(ctx);
  if (p.action === "menu") return menuAction(ctx, call, p);
  const app = await resolveApp(ctx, call, p.app);
  const window = await resolveWindow(ctx, call, app, p.window);
  if (
    pinned &&
    (window.id !== pinned.id ||
      window.pid !== pinned.pid ||
      JSON.stringify(window.bounds) !== JSON.stringify(pinned.bounds))
  )
    throw notDelivered("target_moved", "batch_window_changed");
  const { token, facts, known } = await factsFor(ctx, call, window, p.elementId);
  if (p.action === "setValue" || (p.action === "select" && p.value !== undefined))
    await refuseSecure(ctx, call, window, facts, {
      requireProof: p.action === "setValue" && !ctx.driver.features.secureTree,
      pick: p.action === "select",
    });
  const step = planUiAction(known, token, facts, p.action, p.value);
  if (p.action === "setValue") await confirmUnscannedInput(ctx, call, window, token, facts);
  // A platform that can select without the pointer answers here. Cua's Windows "pick"
  // click moved the real cursor onto the row and back, which the user sees, so when the element
  // is not selectable that way the step is refused and pointed at press / keys instead of
  // clicking silently.
  if (step.action === "select" && p.value === undefined && ctx.driver.selectElement) {
    if (!facts.frame) throw new ComputerError("unsupported", "element_not_visible_scroll_first");
    const answer = await ctx.driver.selectElement(window, facts.frame, call.signal);
    if (answer === "selected")
      return { ok: true, effect: "confirmed" } satisfies R<"host.computer.uiAction">;
    if (answer === "selected_unverified")
      return { ok: true, effect: "unverified" } satisfies R<"host.computer.uiAction">;
    // UI Automation's Select on a XAML control activates its window. The row is
    // selected, so this is not a failure — but claiming "confirmed" would hide a visible side
    // effect the model did not ask for, so the result says the app came forward.
    if (answer === "selected_foreground")
      return {
        ok: true,
        effect: "unverified",
        note: "brought_window_to_front",
      } satisfies R<"host.computer.uiAction">;
    throw new ComputerError(
      "unsupported",
      answer === "unsupported"
        ? "select_needs_pointer_use_press_or_keys"
        : "select_not_verified_use_press_or_keys",
    );
  }
  try {
    const effect = await ctx.driver.uiAction(window, step.token, step.action, p.value, call.signal);
    return { ok: true, effect } satisfies R<"host.computer.uiAction">;
  } catch (error) {
    throw explainUiFailure(error, facts, step.ax);
  }
}

/** Screenshot pixels → global points, checked against where the window is now. */
async function pointerTarget(ctx: ServiceContext, call: Call, p: P<"host.computer.pointer">) {
  const frame = ctx.frames.get(p.screenshotId, call.grantKey);
  if (!frame) throw notDelivered("stale_screenshot", "take_a_new_screenshot");
  if (!inside(frame, p) || (p.to && !inside(frame, p.to)))
    throw notDelivered("driver_error", "point_outside_screenshot");
  const app = await resolveApp(ctx, call, p.app);
  const at = toGlobal(frame, p);
  const to = p.to && toGlobal(frame, p.to);
  let window: WindowInfo;
  if (frame.kind === "window") {
    if (frame.pid !== app.pid) throw notDelivered("stale_screenshot", "screenshot_of_other_app");
    window = await resolveWindow(ctx, call, app, frame.windowId);
    if (window.id !== frame.windowId) throw notDelivered("target_moved", "window_closed");
  } else {
    // Pointer coordinates are judged against where the window is now, so this list is never
    // reused from the cache.
    const windows = await windowsOf(ctx, call.signal, app.pid, true);
    const hit = windows.find((w) => w.layer === 0 && w.onScreen && contains(w.bounds, at));
    if (!hit) throw notDelivered("target_moved", "point_not_on_app_window");
    window = await resolveWindow(ctx, call, app, hit.id);
  }
  // A window that moved since the screenshot would send the click somewhere else.
  const moved =
    frame.kind === "window" &&
    (Math.abs(window.bounds.x - frame.origin.x) > 2 ||
      Math.abs(window.bounds.y - frame.origin.y) > 2);
  if (moved || !contains(window.bounds, at) || (to && !contains(window.bounds, to)))
    throw notDelivered("target_moved", "take_a_new_screenshot");
  return { app, window, at, to };
}

export async function pointer(ctx: ServiceContext, call: Call, p: P<"host.computer.pointer">) {
  invalidateSecureScans(ctx);
  if (!call.scope.allowCoordinates) throw new ComputerError("coordinates_not_allowed");
  const { window, at, to } = await pointerTarget(ctx, call, p);
  if (p.delivery === "foreground" && (await ctx.driver.session(call.signal)).locked)
    throw new ComputerError("screen_locked");
  const delivery = await ctx.driver.pointer(
    window,
    {
      kind: p.kind,
      at,
      to,
      dx: p.dx,
      dy: p.dy,
      delivery: p.delivery,
      inject: (run) => ctx.activity.injecting(call.scope.runId, run),
    },
    call.signal,
  );
  // A click or drag can move or close this app's windows.
  forgetWindows(ctx, window.pid);
  return { ok: true, delivery } satisfies R<"host.computer.pointer">;
}

export async function keys(ctx: ServiceContext, call: Call, p: P<"host.computer.keys">) {
  invalidateSecureScans(ctx);
  if (p.text === undefined && p.combo === undefined)
    throw notDelivered("driver_error", "text_or_combo_required");
  const app = await resolveApp(ctx, call, p.app);
  const window = await resolveWindow(ctx, call, app, p.window);
  if (p.delivery === "foreground") {
    assertAppShortcut(ctx.driver.platform, p.combo);
    assertFrontmost(await ctx.driver.frontmostApp(call.signal), app);
  }
  const target = p.elementId ? await factsFor(ctx, call, window, p.elementId) : undefined;
  const facts = target?.facts;
  const shortcut = p.text === undefined && isNonTextShortcut(ctx.driver.platform, p.combo);
  const secure = shortcut
    ? false
    : await refuseSecure(ctx, call, window, facts, {
        requireProof: !!facts && !ctx.driver.features.secureTree,
      });
  // Without an element and without an OS focus check we cannot rule out a password field. Only a
  // proven "not a password field" lets free-form text through (a platform that cannot see
  // the real receiver answers "unknown", and its keys used to land in a background password field);
  // an incomplete scan still gets its separate confirmation in confirmUnscannedInput.
  if (!facts && secure === "unknown" && !ctx.elements.get(windowKey(window))?.secureScanIncomplete)
    throw new ComputerError("unsupported", "focus_check_unavailable_use_elementId");
  if (p.delivery === "foreground" && (await ctx.driver.session(call.signal)).locked)
    throw new ComputerError("screen_locked");
  if (!shortcut) await confirmUnscannedInput(ctx, call, window, target?.token, facts);
  let delivery: Awaited<ReturnType<typeof ctx.driver.keys>>;
  try {
    delivery = await ctx.driver.keys(
      window,
      {
        elementToken: target?.token,
        text: p.text,
        combo: p.combo,
        delivery: p.delivery,
        inject: (run) => ctx.activity.injecting(call.scope.runId, run),
      },
      call.signal,
    );
  } catch (error) {
    call.signal.throwIfAborted();
    if (
      !(error instanceof ComputerError) ||
      !error.detail?.startsWith("no_focused_text_input") ||
      p.text === undefined
    )
      throw error;
    const snapshot = ctx.elements.get(windowKey(window));
    const focusTargets =
      snapshot?.secureScanIncomplete || snapshot?.grantKey !== call.grantKey
        ? []
        : [...(snapshot?.facts ?? [])]
            .filter(
              ([, fact]) =>
                !fact.secure &&
                fact.enabled !== false &&
                /textfield|textarea|searchfield|combobox|textbox|entry|edit|^text$/i.test(
                  fact.role,
                ),
            )
            .slice(0, 8)
            .map(([id]) => id);
    throw new ComputerError(
      error.code,
      "no_focused_text_input",
      error.diagnostic,
      undefined,
      {
        focusTargets,
      },
      error.disposition,
    );
  }
  const value = shortcut ? undefined : await focusValue(ctx, call, window);
  // A window shortcut (close, minimise, space) changes the window list under the next call.
  if (p.combo) forgetWindows(ctx, window.pid);
  return {
    ok: true,
    delivery,
    ...(value !== undefined ? { focusValue: value } : {}),
  } satisfies R<"host.computer.keys">;
}
