import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "@pibot/ui/tokens.css";
import "./window-titlebar.css";
import { readStartupDisplay } from "./app/startup-read.ts";
import { CachedStartupScreen, StartupPlaceholder } from "./app/startup-screen.tsx";
import { hasTitleStrip, WindowTitleBar } from "./features/window-titlebar/WindowTitleBar.tsx";

const element = document.getElementById("root");
if (!element) throw new Error("Missing renderer root");
const root = createRoot(element);
const takeover = window.location.hash === "#browser-takeover";
if (takeover) {
  const { TakeoverToolbar } = await import("@pibot/browser/ui");
  root.render(<TakeoverToolbar />);
} else {
  const strip = hasTitleStrip();
  if (strip) document.documentElement.dataset.titleStrip = "";
  flushSync(() =>
    root.render(
      <>
        {strip && <WindowTitleBar />}
        <StartupPlaceholder systemLocale={navigator.language} labels={null} />
      </>,
    ),
  );
  // Main serves these before it evaluates its role graph, so the deadline only bounds a
  // stalled main process (loading the translation tables for the labels included); the blank
  // starting page is already up meanwhile.
  const { snapshot, systemLocale, labels } = await readStartupDisplay(
    window.pibotStartup,
    navigator.language,
    1500,
  );
  // Only the bounded initial read supplies this display; late IPC replies cannot replace App.
  flushSync(() =>
    root.render(
      <>
        {strip && <WindowTitleBar />}
        {snapshot && labels ? (
          <CachedStartupScreen snapshot={snapshot} labels={labels} systemLocale={systemLocale} />
        ) : (
          <StartupPlaceholder systemLocale={systemLocale} labels={labels} />
        )}
      </>,
    ),
  );
  // The App graph is evaluated after the cached frame so it cannot delay it. It renders only once
  // the GUI main process has registered the handlers it calls; an older or
  // test main without that gate answers with an error, which only means "already ready".
  const [{ App }] = await Promise.all([
    import("./app/App.tsx"),
    window.pibotStartup?.ready().catch(() => {}),
  ]);
  root.render(
    <>
      {strip && <WindowTitleBar />}
      <App snapshot={snapshot} systemLocale={systemLocale} />
    </>,
  );
}
