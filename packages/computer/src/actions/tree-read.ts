import type { HostComputerParams, HostComputerResults } from "@pibot/protocol-base";
import {
  type Call,
  type CertifiedInput,
  forgetWindows,
  resolveApp,
  resolveWindow,
  type ServiceContext,
  type WindowFacts,
  windowKey,
} from "../core/context.ts";
import { ComputerError } from "../core/errors.ts";
import type { ComputerDriver, RawElement, Rect, WindowInfo } from "../core/types.ts";
import { near, TEXT_ROLE } from "./secure-input.ts";
import {
  type ElementIdentity,
  identitiesOf,
  identityKey,
  isSecureElement,
  toElements,
} from "./tree.ts";

/** The read limits `ui_tree` uses when the model gives none; actions verify with the same ones. */
export const DEFAULT_TREE_LIMITS = { maxNodes: 200, maxDepth: 64 };

/** How many model-issued tokens a window keeps for later element actions. */
const ISSUED_TOKENS = 2048;

type P<K extends keyof HostComputerParams> = HostComputerParams[K];
type R<K extends keyof HostComputerResults> = HostComputerResults[K];

function rememberElements(
  ctx: ServiceContext,
  window: WindowInfo,
  read: WindowFacts,
  issued: boolean,
) {
  const key = windowKey(window);
  const older = ctx.elements.get(key);
  // Tokens the model already holds stay resolvable however many reads later: actions read the
  // tree themselves before acting, and a bounded snapshot history dropped the model's
  // read after nine of them.
  if (older?.issued) read.issued = older.issued;
  if (issued) {
    read.issued ??= new Map();
    for (const [token, facts] of read.facts) {
      read.issued.delete(token);
      read.issued.set(token, facts);
    }
    while (read.issued.size > ISSUED_TOKENS)
      read.issued.delete(read.issued.keys().next().value as string);
  }
  ctx.elements.delete(key);
  ctx.elements.set(key, read);
  while (ctx.elements.size > 16) ctx.elements.delete(ctx.elements.keys().next().value as string);
}

/**
 * One window read end to end: driver tree, OS password-field marking, protocol mapping and the
 * facts snapshot later actions re-identify against. `ui_tree` and the pre-action element check
 * share it, so an action is verified against exactly the kind of read the model saw —
 * including the password-field marks, which a lighter read could not be trusted to authorize
 * input.
 */
export async function readWindow(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  limits: { maxNodes: number; maxDepth: number },
  filter?: string,
  options: { issued?: boolean } = {},
): Promise<{
  raw: Awaited<ReturnType<ComputerDriver["readTree"]>>;
  mapped: ReturnType<typeof toElements>;
  scanned: boolean;
}> {
  const readStarted = performance.now();
  let raw: Awaited<ReturnType<ComputerDriver["readTree"]>>;
  try {
    raw = await ctx.driver.readTree(
      window,
      {
        maxNodes: limits.maxNodes,
        maxDepth: limits.maxDepth,
        onDisplayRead: (value) => {
          call.displayRead = value;
        },
      },
      call.signal,
    );
  } catch (error) {
    // A reused window list can still name a window that closed since it was read; drop it so the
    // next resolution asks the OS instead of aiming at the same gone window.
    if (error instanceof ComputerError && error.code === "window_not_found")
      forgetWindows(ctx, window.pid);
    throw error;
  }
  if (raw.displayRead) call.displayRead = raw.displayRead;
  if (call.treeTiming) call.treeTiming.readMs = performance.now() - readStarted;
  const secureStarted = performance.now();
  // One identity pass for the whole read: the scan's certification and the facts the model's
  // tokens are later checked against must agree on what an element is.
  const identities = identitiesOf(raw.elements);
  const { scanned, uncertified } = await markSecure(
    ctx,
    call,
    window,
    raw.elements,
    identities,
    raw.truncated,
    raw.requireFreshSecureScan,
  );
  if (call.treeTiming) call.treeTiming.secureMs = performance.now() - secureStarted;
  const mapStarted = performance.now();
  const mapped = toElements(raw.elements, {
    filter,
    maxNodes: limits.maxNodes,
    maxDepth: limits.maxDepth,
    identities,
  });
  if (call.treeTiming) call.treeTiming.mapMs = performance.now() - mapStarted;
  for (const e of raw.elements)
    if (e.token && uncertified.has(e.index)) {
      const facts = mapped.facts.get(e.token);
      if (facts) facts.secureUnverified = true;
    }
  // Offline work-cost probe: filter caused 1600 driver nodes for a 400-node response.
  rememberElements(
    ctx,
    window,
    {
      facts: mapped.facts,
      secureScanIncomplete: uncertified.size > 0,
      grantKey: call.grantKey,
      limits,
    },
    options.issued === true,
  );
  return { raw, mapped, scanned };
}

/**
 * How long a complete scan vouches for the text fields it saw. Forms are replaced in place — a
 * login page swaps its fields after submit, a single-page app swaps its whole view — so geometry
 * plus identity is evidence about *this* form only while it has not had time to be replaced. One
 * minute is longer than any action loop (a click is ~1 s) and shorter than a user's form filling;
 * after that input goes back to the OS focus check (fail closed).
 */
const CERTIFIED_TTL_MS = 60_000;

/**
 * Marks elements sitting exactly on an OS-reported password field (and their descendants), and
 * reports which text elements this read could not vouch for.
 *
 * Whether an input field is a password field is a property of the newest *complete* scan of that
 * window, not of this particular read. Element actions read the tree before acting, so
 * most reads reuse a scan from a second ago, and calling a reused scan "not scanned" refused
 * every background write on macOS.
 *
 * A text element is certified only when a complete scan covered **that element**: same identity
 * (role, ancestors, label, place among identical siblings) at the same place, within
 * `CERTIFIED_TTL_MS`. Geometry alone is not enough — the field at a position can be replaced by a
 * password field (submit, or a view swapped in place), and an identity-and-place match is what
 * tells the scan looked at this very element. A text field that appeared after that scan, sits
 * somewhere else, or a window we never got a complete scan for, stays uncertified and needs the OS
 * focus check.
 */
async function markSecure(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  raw: RawElement[],
  identities: Map<number, ElementIdentity>,
  partialTree: boolean,
  requireFresh = false,
): Promise<{ scanned: boolean; uncertified: Set<number> }> {
  // The OS walk costs ~10 ms per node; only pay it when there is a text input to protect.
  if (!ctx.driver.secureFrames || !raw.some((e) => TEXT_ROLE.test(e.role)))
    return { scanned: true, uncertified: new Set() };
  ctx.secureScans ??= new Map();
  ctx.secureKnown ??= new Map();
  const scans = ctx.secureScans;
  const known = ctx.secureKnown;
  const key = windowKey(window);
  const previous = scans.get(key);
  const now = (ctx.now ?? Date.now)();
  // A scan belongs to the window named by pid + window id (the map key), under the same grant. Its
  // geometry is deliberately not compared: on macOS the window server reports a background app's
  // window as Stage Manager's side-strip thumbnail, which changes as windows come forward, and an
  // equality test on it discarded certifications that still held. A window that
  // really moved takes its elements with it, so the identity-and-place check below fails on the
  // frames alone — the stricter test stays, the misleading one goes.
  const sameGrant = (scan: { grantKey: string }) => scan.grantKey === call.grantKey;
  const cached =
    !requireFresh &&
    previous !== undefined &&
    // A complete small tree needs live values (e.g. Calculator's display). Do not reuse a
    // positive scan whose safe cache rule would suppress every value in that whole window.
    (!previous.complete || partialTree) &&
    sameGrant(previous) &&
    now - previous.at >= 0 &&
    now - previous.at < 10_000;
  const certifiedInputs: CertifiedInput[] = [];
  for (const e of raw) {
    if (!TEXT_ROLE.test(e.role) || !e.frame) continue;
    // No identity means no way to tell this field from a replacement later: not certified.
    const identity = identityKey(identities.get(e.index));
    if (identity !== undefined) certifiedInputs.push({ key: identity, frame: e.frame });
  }
  const result =
    cached && previous
      ? previous
      : await ctx.driver.secureFrames(
          window.pid,
          { title: window.title, bounds: window.bounds },
          call.signal,
        );
  call.signal.throwIfAborted();
  if (!cached) {
    if (call.treeTiming && "timing" in result && result.timing) {
      call.treeTiming.secureWindowMs = result.timing.windowMs;
      call.treeTiming.secureAttributesMs = result.timing.attributesMs;
      call.treeTiming.secureQueueMs = result.timing.queueMs;
    }
    scans.delete(key);
    scans.set(key, {
      ...result,
      at: now,
      grantKey: call.grantKey,
      certified: certifiedInputs,
    });
    while (scans.size > 16) scans.delete(scans.keys().next().value as string);
  }
  const { frames, complete } = result;
  // The newest complete geometry outlives the cache: password fields do not disappear on a timer,
  // and forgetting them both unmarks them in the tree and withdraws the certification of every
  // plain text field in that window.
  if (complete)
    known.set(key, {
      grantKey: call.grantKey,
      frames,
      // A cached scan keeps the moment it ran: its certification must age from then, not from now.
      at: cached && previous ? previous.at : now,
      // A remembered scan keeps the fields it saw; the current read's list is the fallback for an
      // entry recorded before this field existed.
      certified: cached && previous ? (previous.certified ?? certifiedInputs) : certifiedInputs,
    });
  while (known.size > 16) known.delete(known.keys().next().value as string);
  const remembered = known.get(key);
  const trusted = remembered && sameGrant(remembered) ? remembered : undefined;
  // Values from a reused or partial scan cannot be shown: the geometry that suppressed them may
  // be older than the window's contents.
  if (cached || !complete)
    for (const e of raw) {
      if (isSecureElement(e)) e.secure = true;
      e.value = undefined;
      e.valueDescription = undefined;
    }
  const freshTrust =
    trusted !== undefined && now - trusted.at >= 0 && now - trusted.at < CERTIFIED_TTL_MS;
  // Password fields do not disappear on a timer, so the newest complete scan's geometry outlives
  // the scan cache — but only while it is fresh: geometry from a minute ago can describe a window
  // that has since moved.
  const marks = complete || !trusted || !freshTrust ? frames : [...frames, ...trusted.frames];
  const secure = new Set<number>();
  for (const e of raw) {
    const parentSecure = e.parentIndex !== undefined && secure.has(e.parentIndex);
    if (
      isSecureElement(e) ||
      parentSecure ||
      (e.frame && marks.some((f) => near(f, e.frame as Rect)))
    ) {
      secure.add(e.index);
      e.secure = true;
    }
  }
  const scannedNow = !cached && complete;
  // A scan that ran over this very tree covered all of its text inputs; a remembered one covers
  // only the elements it saw, in the place it saw them, and only while it is still fresh.
  const covered = (e: RawElement): boolean => {
    if (secure.has(e.index) || !e.frame) return false;
    if (scannedNow) return true;
    if (!freshTrust || !trusted) return false;
    const identity = identityKey(identities.get(e.index));
    return (
      identity !== undefined &&
      trusted.certified.some((c) => c.key === identity && near(c.frame, e.frame as Rect))
    );
  };
  const uncertified = new Set<number>();
  for (const e of raw) {
    if (!TEXT_ROLE.test(e.role) || secure.has(e.index)) continue;
    if (!covered(e)) uncertified.add(e.index);
  }
  // Uncensored text fields stay plain: `secure` comes only from a scan that saw a password field
  // there (or from the newest complete scan of the same element). Marking every user of a window
  // that was never scanned as a password field — an earlier fallback — made the model treat
  // each input box as a password box and reported `secure_field` for input refused for a wholly
  // different reason. The refusal itself is unchanged: `uncertified` becomes
  // `secureUnverified`, and input still needs the OS focus check, which reports
  // `secure_scan_incomplete` when it cannot be made.
  return { scanned: scannedNow, uncertified };
}

export async function uiTree(ctx: ServiceContext, call: Call, p: P<"host.computer.uiTree">) {
  const app = await resolveApp(ctx, call, p.app);
  const window = await resolveWindow(ctx, call, app, p.window);
  // Keep the read budget explicit; Intel Notes phase timings still require host validation.
  const maxNodes = p.maxNodes ?? DEFAULT_TREE_LIMITS.maxNodes;
  // Small SwiftUI windows can put their display behind >12 structural containers.
  // Depth is not a work-size estimate: the node budget still bounds the whole read.
  const maxDepth = p.depth ?? DEFAULT_TREE_LIMITS.maxDepth;
  const { raw, mapped, scanned } = await readWindow(
    ctx,
    call,
    window,
    { maxNodes, maxDepth },
    p.filter,
    // These are the tokens the model will act on; internal reads must not evict them.
    { issued: true },
  );
  if (call.displayRead) {
    const displayIds = new Set(raw.displayElementIndexes?.map((index) => `#${index}`));
    call.displayRead.visible = mapped.elements.filter(
      (element) => displayIds.has(element.id) && element.value !== undefined,
    ).length;
    call.displayRead.visibility = !call.displayRead.found
      ? "no_values"
      : !scanned
        ? "secure_scan_incomplete"
        : call.displayRead.visible
          ? "visible"
          : "filtered_or_hidden";
  }
  const result = {
    ok: true,
    window: { id: window.id, title: window.title.slice(0, 500) },
    elements: mapped.elements,
    truncated: raw.truncated || mapped.truncated,
    ...(raw.truncated || mapped.truncated
      ? {
          truncation: raw.truncation ?? {
            reason:
              raw.elements.length >= maxNodes
                ? ("node_limit" as const)
                : raw.elements.some((e) => e.depth >= maxDepth)
                  ? ("depth_limit" as const)
                  : ("driver" as const),
            depthReached: raw.elements.reduce((depth, e) => Math.max(depth, e.depth), 0),
            // Native partial trees do not expose an exact count; never invent one.
            remainingNodes: raw.truncated ? null : mapped.omitted,
          },
        }
      : {}),
  } satisfies R<"host.computer.uiTree">;
  // Measure the bounded DTO encoding cost, not IPC/network latency or any UI text in logs.
  const serializeStarted = performance.now();
  JSON.stringify(result);
  if (call.treeTiming) call.treeTiming.serializeMs = performance.now() - serializeStarted;
  return result;
}
