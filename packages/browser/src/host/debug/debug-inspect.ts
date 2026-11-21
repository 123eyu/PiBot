import {
  type BrowserElementSummary,
  BrowserElementSummarySchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import { z } from "zod";
import type { BotTab } from "../tab.ts";
import { debugText } from "./debug-diagnostics.ts";

const nodeSchema = z.object({
  node: z.object({
    nodeId: z.number().int(),
    backendNodeId: z.number().int(),
    localName: z.string(),
    attributes: z.array(z.string()).optional(),
  }),
});
const styleSchema = z.object({
  computedStyle: z.array(z.object({ name: z.string(), value: z.string() })),
});
const styles = new Set([
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "gap",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border-radius",
  "overflow-x",
  "overflow-y",
  "visibility",
  "opacity",
  "align-items",
  "justify-content",
  "flex-direction",
  ...["margin", "padding"].flatMap((prefix) =>
    ["top", "right", "bottom", "left"].map((side) => `${prefix}-${side}`),
  ),
]);
const stale = () => new RpcError(RpcErrorCodes.invalidParams, "browser_selection_stale");

/** Only fixed CDP reads; HTML, custom properties and form values are never returned. */
export async function inspectNode(
  tab: BotTab,
  backendNodeId: number,
  documentId: string,
): Promise<BrowserElementSummary> {
  if (!tab.debugSupported)
    throw new RpcError(RpcErrorCodes.unsupported, "browser_debug_unsupported");
  if (tab.documentId !== documentId) throw stale();
  const cdp = tab.control;
  await cdp.send("DOM.getDocument", { depth: 0 });
  const ids = z
    .object({ nodeIds: z.array(z.number().int()) })
    .parse(
      await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] }),
    );
  const nodeId = ids.nodeIds[0];
  if (!nodeId) throw stale();
  const { node } = nodeSchema.parse(await cdp.send("DOM.describeNode", { nodeId, depth: 0 }));
  const attrs = new Map<string, string>();
  for (let i = 0; i < (node.attributes?.length ?? 0) - 1; i += 2)
    attrs.set(node.attributes?.[i] ?? "", node.attributes?.[i + 1] ?? "");
  const secret =
    node.localName === "input" &&
    (attrs.get("type") === "password" ||
      /password|one-time-code|cc-number|cc-csc|cc-exp/i.test(attrs.get("autocomplete") ?? ""));
  let bounds: BrowserElementSummary["bounds"] = null;
  try {
    const box = z
      .object({ model: z.object({ border: z.array(z.number().finite()).length(8) }) })
      .parse(await cdp.send("DOM.getBoxModel", { nodeId }));
    const xs = [
      box.model.border[0],
      box.model.border[2],
      box.model.border[4],
      box.model.border[6],
    ] as number[];
    const ys = [
      box.model.border[1],
      box.model.border[3],
      box.model.border[5],
      box.model.border[7],
    ] as number[];
    bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  } catch {
    /* Nodes without layout (display:none) have no box. */
  }
  const computed = styleSchema.parse(await cdp.send("CSS.getComputedStyleForNode", { nodeId }));
  if (tab.documentId !== documentId) throw stale();
  return BrowserElementSummarySchema.parse({
    documentId,
    ref: tab.refs.ref(backendNodeId),
    tag: node.localName.slice(0, 64),
    secret,
    frameSupported: true,
    bounds,
    name: secret ? "[secret]" : debugText(attrs.get("aria-label") ?? "", tab.redact).slice(0, 200),
    styles: computed.computedStyle
      .filter((item) => styles.has(item.name) && !/url\s*\(/i.test(item.value))
      .slice(0, 40)
      .map((item) => ({ name: item.name, value: debugText(item.value, tab.redact).slice(0, 200) })),
  });
}

export async function inspectPoint(
  tab: BotTab,
  point: { documentId: string; frameSeq: number; x: number; y: number },
) {
  if (!tab.matchesFrame(point)) throw stale();
  const version = tab.viewVersion;
  const hit = z.object({ backendNodeId: z.number().int(), frameId: z.string() }).parse(
    await tab.control.send("DOM.getNodeForLocation", {
      x: point.x,
      y: point.y,
      includeUserAgentShadowDOM: false,
    }),
  );
  const frames = z
    .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
    .parse(await tab.control.send("Page.getFrameTree"));
  if (hit.frameId !== frames.frameTree.frame.id)
    throw new RpcError(RpcErrorCodes.unsupported, "browser_inspect_unavailable");
  const result = await inspectNode(tab, hit.backendNodeId, point.documentId);
  // New animation frames may have been published during the reads. The original frame was
  // checked at admission; navigation, scrolling and viewport changes still invalidate the hit.
  if (
    version !== tab.viewVersion ||
    tab.documentId !== point.documentId ||
    tab.viewportBusy ||
    tab.loading
  )
    throw stale();
  return result;
}
