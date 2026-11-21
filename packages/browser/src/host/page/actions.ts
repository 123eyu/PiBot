import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { Cdp } from "../cdp.ts";
import type { BotTab } from "../tab.ts";
import type { Mark } from "./phases.ts";
import { screenshotPage } from "./screenshot.ts";
import type { RefTable } from "./snapshot.ts";

export { screenshotPage } from "./screenshot.ts";

const fail = (message: string, code: number = RpcErrorCodes.invalidParams) =>
  new RpcError(code, message);

function nodeOf(refs: RefTable, ref: string) {
  const backendNodeId = refs.node(ref);
  // Refs die with their document; the model has to take a new snapshot.
  if (backendNodeId === undefined) throw fail("browser_ref_not_found");
  return backendNodeId;
}

async function objectOf(cdp: Cdp, backendNodeId: number) {
  try {
    const { object } = await cdp.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId,
    });
    if (!object.objectId) throw fail("browser_ref_not_found");
    return object.objectId;
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCodes.timeout) throw error;
    throw fail("browser_ref_not_found");
  }
}

async function callOn<T>(cdp: Cdp, objectId: string, fn: string, args: unknown[] = []) {
  const { result, exceptionDetails } = await cdp.send<{
    result: { value?: unknown };
    exceptionDetails?: unknown;
  }>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  if (exceptionDetails) throw fail("browser_action_failed", RpcErrorCodes.unsupported);
  return result.value as T;
}

async function center(cdp: Cdp, backendNodeId: number) {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
    // Some nodes (e.g. inside closed shadow roots) cannot scroll; quads still decide visibility.
  });
  const { quads } = await cdp
    .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId })
    .catch(() => ({ quads: [] as number[][] }));
  const quad = quads.find((q) => q.length === 8);
  if (!quad) throw fail("browser_ref_not_visible");
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
}

export async function clickRef(cdp: Cdp, refs: RefTable, ref: string) {
  const { x, y } = await center(cdp, nodeOf(refs, ref));
  await clickPoint(cdp, { x, y });
}

export async function clickPoint(cdp: Cdp, { x, y }: { x: number; y: number }) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

const SECRET_FIELD = `function () {
  return this instanceof HTMLInputElement &&
    (this.type === "password" || /(password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(this.autocomplete || ""));
}`;

export async function typeRef(
  cdp: Cdp,
  refs: RefTable,
  ref: string,
  text: string,
  submit: boolean,
) {
  const backendNodeId = nodeOf(refs, ref);
  const objectId = await objectOf(cdp, backendNodeId);
  // Logins happen only by user takeover; secret fields never receive Bot input.
  if (await callOn<boolean>(cdp, objectId, SECRET_FIELD)) throw fail("browser_secret_field");
  await cdp.send("DOM.focus", { backendNodeId }).catch(() => {
    throw fail("browser_ref_not_editable");
  });
  // Replace the current content like a fill: select it, then insertText overwrites the selection.
  await callOn(
    cdp,
    objectId,
    `function () {
      if (typeof this.select === "function") this.select();
      else if (this.isContentEditable) document.execCommand("selectAll");
    }`,
  );
  if (text) await cdp.send("Input.insertText", { text });
  else
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Delete",
      code: "Delete",
      windowsVirtualKeyCode: 46,
    });
  if (submit)
    for (const type of ["rawKeyDown", "char", "keyUp"])
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "char" ? { text: "\r" } : {}),
      });
}

export async function selectRef(cdp: Cdp, refs: RefTable, ref: string, value: string) {
  const objectId = await objectOf(cdp, nodeOf(refs, ref));
  const chosen = await callOn<string | null>(
    cdp,
    objectId,
    `function (wanted) {
      if (!(this instanceof HTMLSelectElement)) return null;
      const option = [...this.options].find((o) => o.value === wanted) ||
        [...this.options].find((o) => o.text.trim() === wanted.trim());
      if (!option || option.disabled) return null;
      this.value = option.value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return option.value;
    }`,
    [value],
  );
  if (chosen === null) throw fail("browser_option_not_found");
}

export async function uploadRef(cdp: Cdp, refs: RefTable, ref: string, files: string[]) {
  const backendNodeId = nodeOf(refs, ref);
  const objectId = await objectOf(cdp, backendNodeId);
  const isFile = await callOn<boolean>(
    cdp,
    objectId,
    `function () { return this instanceof HTMLInputElement && this.type === "file"; }`,
  );
  if (!isFile) throw fail("browser_not_file_input");
  await cdp.send("DOM.setFileInputFiles", { files, backendNodeId });
}

export async function scrollPage(cdp: Cdp, direction: string, amount = 600) {
  const { cssLayoutViewport: view } = await cdp.send<{
    cssLayoutViewport: { clientWidth: number; clientHeight: number };
  }>("Page.getLayoutMetrics");
  const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: view.clientWidth / 2,
    y: view.clientHeight / 2,
    deltaX,
    deltaY,
  });
}

const timedOut = (error: unknown) =>
  error instanceof RpcError && error.code === RpcErrorCodes.timeout;

/** Capture hidden tabs from Chromium's surface instead of waiting for an OS compositor frame. */
export async function screenshotTab(
  tab: Pick<BotTab, "control" | "contents" | "repaint" | "visibleOnScreen" | "redrawForCapture">,
  fullPage: boolean,
  mark?: Mark,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await tab.repaint();
  mark?.("repaint");
  const hidden = !tab.visibleOnScreen;
  if (hidden) {
    // Keep the macOS hidden-window repair: invalidate plus two animation frames prompts the
    // once-shown software compositor to draw again. It is harmless on Linux/Xvfb and Windows.
    tab.contents.invalidate();
    await tab.control
      .send(
        "Runtime.evaluate",
        {
          expression:
            "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))",
          awaitPromise: true,
        },
        1000,
        signal,
      )
      // A page that cannot answer still gets its surface capture attempt; the timeout reports it.
      .catch(() => {});
    mark?.("frame");
  }
  const surfaceClip = fullPage || hidden;
  try {
    return await screenshotPage(tab.control, fullPage, surfaceClip, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (!timedOut(error)) throw error;
  } finally {
    mark?.("capture");
  }
  signal?.throwIfAborted();
  await tab.redrawForCapture();
  signal?.throwIfAborted();
  mark?.("redraw");
  try {
    return await screenshotPage(tab.control, fullPage, surfaceClip, signal);
  } catch (error) {
    if (timedOut(error)) throw fail("browser_screenshot_frame_timeout", RpcErrorCodes.timeout);
    throw error;
  } finally {
    mark?.("capture_retry");
  }
}

export async function pageHasText(cdp: Cdp, value: string) {
  const { result } = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
    expression: `(() => { const t = document.body ? document.body.innerText : ""; return t.includes(${JSON.stringify(value)}); })()`,
    returnByValue: true,
  });
  return result.value === true;
}

export async function refVisible(cdp: Cdp, refs: RefTable, ref: string) {
  const backendNodeId = nodeOf(refs, ref);
  // Polling must not scroll the page, so only ask for the layout boxes.
  const { quads } = await cdp
    .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId })
    .catch(() => ({ quads: [] as number[][] }));
  return quads.some((q) => q.length === 8);
}
