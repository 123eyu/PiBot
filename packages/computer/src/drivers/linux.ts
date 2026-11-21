import { ComputerError } from "../core/errors.ts";
import type { ComputerDriver, SessionState } from "../core/types.ts";
import type { Cua } from "../cua/loader.ts";
import { createCuaComputerDriver } from "./cua-driver.ts";

/**
 * Linux (X11 + AT-SPI): Cua's element path works; background keyboard input needs
 * /dev/uinput and Cua's typed text loses non-ASCII characters ("cua-linux 测试" arrived
 * as "cua-linux"). Until there is a fallback (setValue or clipboard paste), non-ASCII text is
 * refused instead of being typed partially. Wayland needs CUA_DRIVER_RS_ENABLE_WAYLAND and a
 * portal; not enabled here.
 */
export function createLinuxDriver(options: {
  load(): Promise<Cua>;
  session(signal?: AbortSignal): Promise<SessionState>;
  timeoutMs?: number;
}): ComputerDriver {
  const base = createCuaComputerDriver({
    platform: "linux",
    load: options.load,
    timeoutMs: options.timeoutMs,
    features: {
      backgroundClick: true,
      backgroundDrag: false,
      backgroundKeys: false,
      secureTree: true,
    },
    // The .desktop id when Cua reports one (same id as app_blocklist.app_id), else the name.
    appId: (app) =>
      app.launchPath
        ?.split("/")
        .pop()
        ?.replace(/\.desktop$/, "") ?? app.name,
    session: options.session,
  }).driver;
  return {
    ...base,
    async keys(window, step, signal) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: printable ASCII range check
      if (step.text !== undefined && /[^\x09\x0a\x0d\x20-\x7e]/.test(step.text))
        throw new ComputerError("unsupported", "non_ascii_text_use_setValue");
      return base.keys(window, step, signal);
    },
  };
}
