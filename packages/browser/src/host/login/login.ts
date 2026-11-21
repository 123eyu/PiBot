import { randomUUID } from "node:crypto";
import {
  credentialSite,
  credentialSiteMatches,
  DomainSchema,
  LOGIN_FIELD_REASONS,
  type LoginFieldReason,
  type LoginFillResult,
} from "@pibot/browser-contract/full";
import type { Logger } from "@pibot/observability";
import type { BotBrowser } from "../bot-browser.ts";
import type { Cdp } from "../cdp.ts";
import type { BotTab } from "../tab.ts";
import {
  LOGIN_BINDING,
  LOGIN_CAPTURE_SCRIPT,
  LOGIN_CAPTURE_WORLD,
  LOGIN_CONTINUE_FUNCTION,
  LOGIN_FILL_FUNCTION,
  LOGIN_FILL_WORLD,
} from "./login-scripts.ts";

/** An unanswered "save this account?" is forgotten after this long (memory only). */
const CAPTURE_TTL_MS = 10 * 60 * 1000;
const MAX_PASSWORD = 1000;
/** A login form can render after the first paint (hydration, a modal); poll, do not sleep. */
const FIELD_WAIT_MS = 2000;
const FIELD_POLL_MS = 200;
/**
 * After the account step's own "Next" / "Continue" the password box is on a new step or a new
 * page; eight seconds covers a slow hydration. A poll, not a sleep: every attempt re-reads the
 * frame tree, so a navigation is followed instead of being reported as a missing box.
 */
const PASSWORD_WAIT_MS = 8000;
const PASSWORD_POLL_MS = 500;
/** Same cap as the hand-back line's sites (protocol `HostBrowserView.signedIn`). */
const MAX_SIGNED_IN = 3;

interface Captured {
  captureId: string;
  site: string;
  username: string;
  password: string;
  timer: ReturnType<typeof setTimeout>;
}
interface FrameNode {
  frame: { id: string; securityOrigin?: string; url?: string };
  childFrames?: FrameNode[];
}

function sameOriginFrames(tree: FrameNode): string[] {
  const origin = tree.frame.securityOrigin;
  const ids = [tree.frame.id];
  const walk = (node: FrameNode) => {
    for (const child of node.childFrames ?? []) {
      // Only the top page and its same-origin iframes are filled.
      if (origin && child.frame.securityOrigin === origin) ids.push(child.frame.id);
      walk(child);
    }
  };
  walk(tree);
  return ids;
}

/** What one fill attempt found; `reasons` explains the account box without any page text. */
interface FilledFields {
  username: boolean;
  password: boolean;
  totp: boolean;
  needsTotp: boolean;
  reasons: LoginFieldReason[];
  /** The frame's origin is no longer the one we checked: the page navigated under us. */
  originMismatch?: boolean;
}

const NOTHING_FOUND: FilledFields = {
  username: false,
  password: false,
  totp: false,
  needsTotp: false,
  reasons: [],
};

// The page script reports codes from a fixed set; anything else (a page that overwrote it) is
// dropped before it can reach the host RPC result.
const KNOWN_REASONS = new Set<string>(LOGIN_FIELD_REASONS);
function reasonsOf(value: unknown): LoginFieldReason[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((code): code is LoginFieldReason => typeof code === "string" && KNOWN_REASONS.has(code))
    .slice(0, 3);
}

interface FillValues {
  username: string;
  password: string;
  origin: string;
  totp?: string;
  totpExpiresAt?: number;
}

/** What one attempt over the page found, and the frame that held it. */
interface DocumentFill {
  found: FilledFields;
  /** The filled box's frame: the intermediate step, if any, is pressed in that frame. */
  frameId?: string;
}

async function fillFrame(
  cdp: Cdp,
  frameId: string,
  values: FillValues,
  assertCurrent: () => void,
): Promise<FilledFields> {
  const { username, password, origin, totp, totpExpiresAt } = values;
  const { executionContextId } = await cdp.send<{ executionContextId: number }>(
    "Page.createIsolatedWorld",
    { frameId, worldName: LOGIN_FILL_WORLD },
  );
  assertCurrent();
  const { result, exceptionDetails } = await cdp.send<{
    result: {
      value?: {
        username?: boolean;
        password?: boolean;
        totp?: boolean;
        needsTotp?: boolean;
        originMismatch?: boolean;
        reasons?: unknown;
      };
    };
    exceptionDetails?: unknown;
  }>("Runtime.callFunctionOn", {
    executionContextId,
    functionDeclaration: LOGIN_FILL_FUNCTION,
    arguments: [
      { value: username },
      { value: password },
      { value: totp && (!totpExpiresAt || Date.now() < totpExpiresAt) ? totp : "" },
      { value: origin },
    ],
    returnByValue: true,
  });
  // exceptionDetails is never logged: it could quote the arguments.
  if (exceptionDetails) return NOTHING_FOUND;
  if (result.value?.originMismatch === true) return { ...NOTHING_FOUND, originMismatch: true };
  return {
    username: result.value?.username === true,
    password: result.value?.password === true,
    totp: result.value?.totp === true,
    needsTotp: result.value?.needsTotp === true,
    reasons: reasonsOf(result.value?.reasons),
  };
}

/**
 * A login form is often rendered after the first paint (hydration, a modal), so the same
 * document is retried every 200 ms for up to two seconds before reporting `no_fields`. It is a
 * poll, not a sleep: `assertCurrent` still runs on every attempt, so a page change or a lost
 * takeover aborts the fill instead of filling a page the user no longer shows.
 */
async function fillDocument(
  cdp: Cdp,
  values: FillValues,
  assertCurrent: () => void,
): Promise<DocumentFill> {
  const deadline = Date.now() + FIELD_WAIT_MS;
  for (;;) {
    assertCurrent();
    // Re-read every time: an embedded login frame can appear along with the late markup.
    const { frameTree } = await cdp.send<{ frameTree: FrameNode }>("Page.getFrameTree");
    for (const frameId of sameOriginFrames(frameTree)) {
      assertCurrent();
      const found = await fillFrame(cdp, frameId, values, assertCurrent);
      if (found.originMismatch) return { found };
      if (found.username || found.password || found.totp || found.needsTotp)
        return { found, frameId };
    }
    if (Date.now() >= deadline) return { found: NOTHING_FOUND };
    await new Promise((resolve) => setTimeout(resolve, FIELD_POLL_MS));
  }
}

/**
 * Presses the account page's own "Next" / "Continue" once, as a real mouse click at the
 * button's centre. Returns false when the page has no such button (the model then falls back to
 * its own click); the final sign-in button is never pressed here. A page that navigated under the
 * press is reported as a page change instead of being clicked blindly.
 */
async function pressStep(
  cdp: Cdp,
  frameId: string,
  origin: string,
  assertCurrent: () => void,
): Promise<boolean> {
  const { executionContextId } = await cdp.send<{ executionContextId: number }>(
    "Page.createIsolatedWorld",
    { frameId, worldName: LOGIN_FILL_WORLD },
  );
  assertCurrent();
  const { result, exceptionDetails } = await cdp.send<{
    result: { value?: { clicked?: boolean; x?: number; y?: number; originMismatch?: boolean } };
    exceptionDetails?: unknown;
  }>("Runtime.callFunctionOn", {
    executionContextId,
    functionDeclaration: LOGIN_CONTINUE_FUNCTION,
    arguments: [{ value: origin }],
    returnByValue: true,
  });
  // exceptionDetails is never logged: it could quote the page's own state.
  if (exceptionDetails) return false;
  if (result.value?.originMismatch === true) throw new Error("credential_page_changed");
  const { x, y } = result.value ?? {};
  if (result.value?.clicked !== true || typeof x !== "number" || typeof y !== "number")
    return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  return true;
}

/**
 * Waits for the password box of a two-step login after the intermediate press. The document
 * is allowed to change here (a navigation is exactly what the press asks for), but the origin and
 * the takeover state are not: a frame between two documents simply has no box yet, so a CDP error
 * means "try again", not a failure. Re-running the whole fill is deliberate: it both detects and
 * fills the box the moment it renders, and writing the same account value again is harmless.
 */
async function waitForPassword(
  cdp: Cdp,
  values: FillValues,
  stillOurs: () => boolean,
): Promise<FilledFields> {
  const deadline = Date.now() + PASSWORD_WAIT_MS;
  const assertCurrent = () => {
    if (!stillOurs()) throw new Error("credential_page_changed");
  };
  for (;;) {
    let frameTree: FrameNode;
    try {
      ({ frameTree } = await cdp.send<{ frameTree: FrameNode }>("Page.getFrameTree"));
    } catch {
      // The tab is going away; what was already filled still stands.
      return NOTHING_FOUND;
    }
    for (const frameId of sameOriginFrames(frameTree)) {
      assertCurrent();
      let found: FilledFields;
      try {
        found = await fillFrame(cdp, frameId, values, assertCurrent);
      } catch (error) {
        if (error instanceof Error && error.message === "credential_page_changed") throw error;
        found = NOTHING_FOUND;
      }
      if (found.originMismatch) return NOTHING_FOUND;
      if (found.password || found.totp || found.needsTotp) return found;
    }
    if (Date.now() >= deadline) return NOTHING_FOUND;
    await new Promise((resolve) => setTimeout(resolve, PASSWORD_POLL_MS));
  }
}

/**
 * In the Bot browser host: fills a saved account into the current page and, while the user
 * has taken over, notices a submitted login form so the app can offer to save it. Passwords live
 * only in this object's memory (and in CDP call arguments); nothing here logs or persists them.
 * Owner: brain-host; `clear()` when the brain goes away, `dispose()` on host stop.
 */
export function createBrowserLogins(logger: Pick<Logger, "info" | "warn">) {
  const captures = new Map<string, Captured>();
  const firstStep = new Map<string, string>();
  // Hostnames where a login was captured during the current takeover, for the
  // hand-back line. Kept apart from `captures`, which outlive the takeover (save prompt, TTL)
  // and are consumed by save / dismiss.
  const signedIn = new Map<string, string[]>();

  const noteSignedIn = (botId: string, site: string) => {
    // The line shows plain hostnames; an address that is not one (IPv6 literal) is left out so
    // the hand-back result always validates.
    const domain = DomainSchema.safeParse(new URL(site).hostname);
    if (!domain.success) return;
    const sites = signedIn.get(botId) ?? [];
    if (sites.includes(domain.data) || sites.length >= MAX_SIGNED_IN) return;
    signedIn.set(botId, [...sites, domain.data]);
  };

  const forget = (botId: string) => {
    const old = captures.get(botId);
    if (old) clearTimeout(old.timer);
    captures.delete(botId);
  };

  const received = (browser: BotBrowser, tab: BotTab, payload: string) => {
    // Outside a takeover this is the Bot's own (or our auto-filled) submission: drop it.
    if (!browser.takeover) return;
    let value: { origin?: unknown; u?: unknown; p?: unknown };
    try {
      value = JSON.parse(payload) as typeof value;
    } catch {
      return;
    }
    let top: string | undefined;
    try {
      top = new URL(tab.url).origin;
    } catch {
      return;
    }
    // Cross-origin frames (embedded widgets) are not this site's login.
    if (typeof value.origin !== "string" || value.origin !== top) return;
    const site = credentialSite(top);
    if (!site) return;
    const username = typeof value.u === "string" ? value.u.slice(0, 500) : "";
    const password = typeof value.p === "string" ? value.p : "";
    if (browser.groupId) return;
    const botId = browser.botId;
    if (!password) {
      if (username) firstStep.set(botId, username);
      return;
    }
    if (password.length > MAX_PASSWORD) return;
    // A password with no account field on the page and no account step before it is
    // not a login (an access code, a PIN); offering to save it only misleads.
    if (!username && !firstStep.has(botId)) return;
    forget(botId);
    const captureId = randomUUID();
    const timer = setTimeout(() => {
      if (captures.get(botId)?.captureId === captureId) captures.delete(botId);
    }, CAPTURE_TTL_MS);
    timer.unref?.();
    captures.set(botId, {
      captureId,
      site,
      username: username || firstStep.get(botId) || "",
      password,
      timer,
    });
    firstStep.delete(botId);
    noteSignedIn(botId, site);
    logger.info(`audit browser.login.captured botId=${botId}`);
  };

  return {
    /** Per tab, right after it opens: capture world + binding (BotBrowserOptions.onTab). */
    async install(browser: BotBrowser, tab: BotTab) {
      const cdp = tab.control;
      cdp.on("Runtime.bindingCalled", (params) => {
        if (params.name === LOGIN_BINDING) received(browser, tab, String(params.payload));
      });
      try {
        await cdp.send("Runtime.addBinding", {
          name: LOGIN_BINDING,
          executionContextName: LOGIN_CAPTURE_WORLD,
        });
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: LOGIN_CAPTURE_SCRIPT,
          worldName: LOGIN_CAPTURE_WORLD,
          runImmediately: true,
        });
      } catch {
        // Without the capture world this tab simply never offers "save this account?".
        logger.warn(`browser login capture unavailable botId=${browser.botId}`);
      }
    },

    /** Fills the active (or given) tab. Recording is muted around it. */
    async fill(
      browser: BotBrowser,
      params: {
        runId?: string;
        tab?: string;
        site: string;
        username: string;
        password: string;
        totp?: string;
        totpExpiresAt?: number;
        takeover?: { tab: string; documentId: string };
      },
    ): Promise<LoginFillResult> {
      const action = async (): Promise<LoginFillResult> => {
        const target = browser.tab(params.takeover?.tab ?? params.tab);
        if (
          params.takeover &&
          (browser.shownTab !== target.id || target.documentId !== params.takeover.documentId)
        )
          return { ok: false, code: "page_changed" };
        if (!credentialSiteMatches(params.site, target.url))
          return { ok: false, code: "origin_mismatch" } as const;
        const documentId = target.documentId;
        const origin = new URL(target.url).origin;
        const assertCurrent = () => {
          if (
            target.documentId !== documentId ||
            new URL(target.url).origin !== origin ||
            (params.takeover &&
              (!browser.takeover || browser.recordingActive || browser.shownTab !== target.id))
          )
            throw new Error("credential_page_changed");
        };
        // The password step may be a new page of the same site: the document is allowed to change
        // there (a navigation is what the intermediate press asks for), the origin and the
        // takeover state are not. A taken-over page that the user left stops the wait at once.
        const stillOurs = () => {
          try {
            if (new URL(target.url).origin !== origin) return false;
          } catch {
            return false;
          }
          return !params.takeover || (!!browser.takeover && browser.shownTab === target.id);
        };
        const values: FillValues = {
          username: params.username,
          password: params.password,
          origin,
          ...(params.totp ? { totp: params.totp } : {}),
          ...(params.totpExpiresAt ? { totpExpiresAt: params.totpExpiresAt } : {}),
        };
        const unmute = browser.muteRecording();
        let found: FilledFields = NOTHING_FOUND;
        let continueClicked = false;
        // The step after the account page asks for a code and the account has no usable TOTP: the
        // account is filled, so this stays a success with a hand-over instead of `totp_unavailable`.
        let needsCode = false;
        try {
          const attempt = await fillDocument(target.control, values, assertCurrent);
          found = attempt.found;
          // The account page has no password box, so the two-step login's own step button is
          // pressed here, once, and the password box is waited for. This is the whole point of the
          // task: the model used to be told to call again on the password page and instead told
          // the user it could not type a password.
          if (found.username && !found.password && !found.totp && attempt.frameId) {
            if (await pressStep(target.control, attempt.frameId, origin, assertCurrent)) {
              continueClicked = true;
              const next = await waitForPassword(target.control, values, stillOurs);
              if (next.password) found = { ...found, password: true };
              else if (next.totp) found = { ...found, totp: true };
              else if (next.needsTotp) needsCode = true;
            }
          }
          // Recorder events for the synthetic input arrive on the same debugger stream before
          // the call returns; a short wait covers any that are still in flight.
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          if (error instanceof Error && error.message === "credential_page_changed")
            return { ok: false, code: "page_changed" };
          throw error;
        } finally {
          unmute();
        }
        if (found.originMismatch) return { ok: false, code: "page_changed" };
        if (found.needsTotp) return { ok: false, code: "totp_unavailable" };
        if (!found.username && !found.password && !found.totp)
          return { ok: false, code: "no_fields" } as const;
        return {
          ok: true,
          username: found.username,
          password: found.password,
          totp: found.totp,
          ...(found.reasons.length ? { reasons: found.reasons } : {}),
          ...(continueClicked ? { continueClicked: true } : {}),
          ...(needsCode ? { needsCode: true } : {}),
          page: browser.page(target),
        } as const;
      };
      return params.takeover
        ? browser.userCredentialFill(action)
        : browser.run(action, params.runId);
    },

    /** Public part of the pending capture, if a login form was submitted during takeover. */
    capture(botId: string) {
      firstStep.delete(botId);
      const value = captures.get(botId);
      return value
        ? { captureId: value.captureId, site: value.site, username: value.username || null }
        : null;
    },

    take(botId: string, captureId: string) {
      const value = captures.get(botId);
      if (!value || value.captureId !== captureId) return undefined;
      forget(botId);
      return { site: value.site, username: value.username, password: value.password };
    },

    discard(botId: string, captureId?: string) {
      if (!captureId || captures.get(botId)?.captureId === captureId) forget(botId);
      firstStep.delete(botId);
    },

    /** A takeover begins: sign-ins from an earlier one must not reach this hand-back line. */
    takeoverStarted(botId: string) {
      signedIn.delete(botId);
    },

    /** Hostnames signed in to during the takeover that just ended, consumed once. */
    takeSignedIn(botId: string): string[] {
      const sites = signedIn.get(botId) ?? [];
      signedIn.delete(botId);
      return sites;
    },

    clear() {
      for (const botId of [...captures.keys()]) forget(botId);
      firstStep.clear();
      signedIn.clear();
    },
  };
}
export type BrowserLogins = ReturnType<typeof createBrowserLogins>;
