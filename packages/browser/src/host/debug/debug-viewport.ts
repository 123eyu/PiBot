import { type BrowserViewport, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { screenshotTab } from "../page/actions.ts";
import type { Mark } from "../page/phases.ts";
import type { BotTab } from "../tab.ts";

/** Keep emulation inside this browser's action lane; it cannot leak into the next run. */
export async function screenshotViewport(
  tab: BotTab,
  fullPage: boolean,
  viewport?: Pick<BrowserViewport, "width" | "height"> &
    Partial<Pick<BrowserViewport, "mobile" | "deviceScaleFactor">>,
  close = () => tab.close(),
  mark?: Mark,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!viewport) return screenshotTab(tab, fullPage, mark, signal);
  tab.setViewportCapture(true);
  let result: Awaited<ReturnType<typeof screenshotTab>> | undefined;
  let failure: unknown;
  try {
    await tab.control.send(
      "Emulation.setDeviceMetricsOverride",
      {
        ...viewport,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile: viewport.mobile ?? false,
      },
      5000,
      signal,
    );
    signal?.throwIfAborted();
    await tab.settle(200, 2000);
    mark?.("emulate");
    result = await screenshotTab(tab, fullPage, mark, signal);
  } catch (error) {
    failure = error;
  }
  try {
    await tab.control.send("Emulation.clearDeviceMetricsOverride", {}, 5000);
  } catch {
    close();
    throw new RpcError(RpcErrorCodes.closed, "browser_viewport_restore_failed");
  } finally {
    tab.setViewportCapture(false);
  }
  if (failure) throw failure;
  if (!result) throw new RpcError(RpcErrorCodes.unsupported, "browser_screenshot_unavailable");
  return result;
}
