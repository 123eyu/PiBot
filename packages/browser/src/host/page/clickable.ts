import { z } from "zod";
import type { Cdp } from "../cdp.ts";

// Isolated-world primitives avoid calling page-provided helpers. A finite walk and result cap
// keep a large page from turning one snapshot into thousands of style reads or CDP requests.
const FIND = `(() => {
  const result = [];
  const walk = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let el, seen = 0, listenerChecks = 0;
  while ((el = walk.nextNode()) && ++seen <= 5000 && result.length < 80) {
    if (!(el instanceof HTMLElement) ||
        /^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(el.tagName) ||
        el.matches('a[href],[role="button"],[role="link"],[role="combobox"],[role="option"],[role="menuitem"]') ||
        el.isContentEditable || el.closest('[contenteditable]:not([contenteditable="false"])')) continue;
    const style = getComputedStyle(el);
    const hint = style.cursor === 'pointer' || el.tabIndex >= 0 || el.hasAttribute('onclick') ||
      (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false');
    const inherited = style.cursor === 'pointer' && el.parentElement &&
      getComputedStyle(el.parentElement).cursor === 'pointer';
    // DevTools' fixed command-line helper sees listeners without instrumenting page code.
    const listener = (!hint || inherited) && ++listenerChecks <= 200 && typeof getEventListeners === 'function' &&
      (getEventListeners(el).click || []).length > 0;
    if (!hint && !listener) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.visibility !== 'visible' || style.display === 'none' ||
        style.pointerEvents === 'none' || box.bottom <= 0 || box.right <= 0 ||
        box.top >= innerHeight || box.left >= innerWidth) continue;
    // cursor inherits: label the control itself, not every span inside a clickable parent.
    if (inherited && el.tabIndex < 0 &&
        !el.hasAttribute('onclick') && !el.hasAttribute('aria-haspopup') && !listener) continue;
    result.push(el);
  }
  return result;
})()`;

const LABEL = `function () {
  let label = this.getAttribute('aria-label') || this.getAttribute('title') || '';
  if (!label) {
    const walk = document.createTreeWalker(this, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return n.nodeType === 1 && (n.matches('input,textarea,select,[contenteditable],script,style'))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node, seen = 0;
    while ((node = walk.nextNode()) && ++seen <= 200 && label.length < 200)
      if (node.nodeType === 3) label += (node.textContent || '').slice(0, 200) + ' ';
  }
  return String(label || this.localName).replace(/\\s+/g, ' ').trim().slice(0, 200);
}`;
const remote = z.object({ objectId: z.string() });
const array = z.object({ result: remote, exceptionDetails: z.unknown().optional() });
const describedNode = z.object({ node: z.object({ backendNodeId: z.number().int().positive() }) });
const labelResult = z.object({ result: z.object({ value: z.string().max(200) }) });

/** Supplement AX refs for visible custom controls; never read form values or secret fields. */
export async function clickableNodes(cdp: Cdp, signal?: AbortSignal) {
  const group = "pibot-snapshot-clickable";
  const nodes = new Map<number, string>();
  const deadline = Date.now() + 8000;
  const send: Cdp["send"] = (method, params) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("browser_snapshot_failed");
    return cdp.send(method, params, remaining);
  };
  try {
    signal?.throwIfAborted();
    const { frameTree } = z
      .object({
        frameTree: z.object({ frame: z.object({ id: z.string() }) }),
      })
      .parse(await send("Page.getFrameTree"));
    const { executionContextId } = z.object({ executionContextId: z.number() }).parse(
      await send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "pibot-snapshot",
      }),
    );
    const found = array.parse(
      await send("Runtime.evaluate", {
        expression: FIND,
        contextId: executionContextId,
        objectGroup: group,
        includeCommandLineAPI: true,
      }),
    );
    if (found.exceptionDetails) throw new Error("browser_snapshot_failed");
    const { result } = z
      .object({
        result: z.array(
          z.object({
            name: z.string(),
            value: z.object({ objectId: z.string().optional() }).optional(),
          }),
        ),
      })
      .parse(
        await send("Runtime.getProperties", {
          objectId: found.result.objectId,
          ownProperties: true,
        }),
      );
    const candidates = result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).slice(0, 80);
    for (let start = 0; start < candidates.length; start += 8) {
      signal?.throwIfAborted();
      await Promise.all(
        candidates.slice(start, start + 8).map(async ({ value }) => {
          const objectId = value?.objectId;
          const [{ node }, label] = await Promise.all([
            send("DOM.describeNode", { objectId }).then((value) => describedNode.parse(value)),
            send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: LABEL,
              returnByValue: true,
            }).then((value) => labelResult.parse(value)),
          ]);
          nodes.set(node.backendNodeId, label.result.value);
        }),
      );
    }
    signal?.throwIfAborted();
    return nodes;
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {
      // Navigation/closure already releases this context's remote objects.
    });
  }
}
