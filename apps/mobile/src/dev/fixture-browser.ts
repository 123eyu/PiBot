import type { BrowserState, createPeer, Events, Methods } from "@pibot/protocol";

/** Explicit, memory-only development fixture for the Bot browser view. */
type ServerPeer = ReturnType<typeof createPeer<typeof Methods, typeof Events>>;
// The smallest valid JPEG-looking base64 payload; the fixture never renders it.
const FRAME_DATA = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";

export function registerBrowser(server: ServerPeer, botId: string) {
  let takeover = false;
  let seq = 0;
  const state = (): BrowserState => ({
    botId,
    open: true,
    tabs: [
      { id: "t1", url: "https://example.com/", title: "Example", active: true, loading: false },
    ],
    takeover,
    viewing: true,
    recording: false,
    lastActivityAt: null,
  });
  server.handle("browser.tabs", async () => state());
  server.handle("remote.browser.frame", async () => ({
    state: state(),
    frame: { seq: ++seq, tabId: "t1", width: 1280, height: 800, data: FRAME_DATA },
    mine: takeover,
  }));
  server.handle("remote.browser.stop", async () => {
    takeover = false;
    return { ok: true as const };
  });
  server.handle("remote.browser.takeover", async ({ on }) => {
    takeover = on;
    return state();
  });
  server.handle("remote.browser.input", async () => {
    if (!takeover) throw new Error("browser_not_taken_over");
    return { ok: true as const };
  });
  server.handle("remote.browser.navigate", async () => state());
}
