import { randomUUID } from "node:crypto";
import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { z } from "zod";
import type { Cdp } from "../cdp.ts";

const metric = z.number().finite();
const viewSchema = z.object({
  clientWidth: metric.positive(),
  clientHeight: metric.positive(),
  pageX: metric,
  pageY: metric,
  offsetX: metric.optional(),
  offsetY: metric.optional(),
  scale: metric.optional(),
});
type View = z.infer<typeof viewSchema>;
interface Identity {
  documentId: string;
  viewVersion: number;
}
const stale = () => new RpcError(RpcErrorCodes.invalidParams, "browser_screenshot_stale");

export async function clickViewport(cdp: Cdp, signal?: AbortSignal): Promise<View> {
  signal?.throwIfAborted();
  const metrics = z
    .object({ cssVisualViewport: viewSchema })
    .parse(await cdp.send("Page.getLayoutMetrics"));
  signal?.throwIfAborted();
  const view = metrics.cssVisualViewport;
  // Pinch-zoom has another coordinate space; a normal viewport screenshot is the safe fallback.
  if ((view.scale ?? 1) !== 1 || (view.offsetX ?? 0) !== 0 || (view.offsetY ?? 0) !== 0)
    throw stale();
  return view;
}

export async function captureClickViewport(cdp: Cdp, signal?: AbortSignal) {
  try {
    return await clickViewport(cdp, signal);
  } catch (error) {
    // Unsupported zoom still permits inspection; it simply cannot issue input authority.
    if (error instanceof RpcError && error.message === "browser_screenshot_stale") return undefined;
    throw error;
  }
}

const sameView = (a: View, b: View) =>
  a.clientWidth === b.clientWidth &&
  a.clientHeight === b.clientHeight &&
  a.pageX === b.pageX &&
  a.pageY === b.pageY;

/** One short-lived capture per tab; the owner invalidates it on navigation, takeover and resize. */
export class ClickCapture {
  private current:
    | (Identity & {
        id: string;
        runId: string;
        at: number;
        width: number;
        height: number;
        view: View;
      })
    | undefined;

  clear() {
    this.current = undefined;
  }

  remember(
    identity: Identity,
    runId: string,
    size: { width: number; height: number },
    before: View,
    after: View,
  ) {
    this.clear();
    if (!sameView(before, after)) return undefined;
    const id = randomUUID();
    this.current = { ...identity, ...size, runId, id, at: Date.now(), view: after };
    return id;
  }

  async consume(
    cdp: Cdp,
    identity: () => Identity,
    runId: string | undefined,
    point: { screenshotId: string; x: number; y: number },
    signal?: AbortSignal,
  ) {
    const capture = this.current;
    this.clear();
    if (
      !capture ||
      capture.id !== point.screenshotId ||
      capture.runId !== runId ||
      Date.now() - capture.at > 30_000 ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= capture.width ||
      point.y >= capture.height
    )
      throw stale();
    const view = await clickViewport(cdp, signal);
    const now = identity();
    if (
      now.documentId !== capture.documentId ||
      now.viewVersion !== capture.viewVersion ||
      !sameView(view, capture.view) ||
      Date.now() - capture.at > 30_000
    )
      throw stale();
    return {
      x: (point.x * view.clientWidth) / capture.width,
      y: (point.y * view.clientHeight) / capture.height,
    };
  }
}
