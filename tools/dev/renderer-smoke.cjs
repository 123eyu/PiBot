// Renderer boot check: load the built renderer (out/renderer) with the real preload in a hidden
// window and fail on any console error, crash or empty root. Unit tests never boot the renderer,
// so a bundle that throws at startup (2026-10-21: routines UI compiled with classic JSX → blank
// window) would otherwise only show up in a packaged app. No window is shown; nothing is sent out.
// Usage: <electron> tools/dev/renderer-smoke.cjs <apps/desktop/out>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const out = path.resolve(process.argv[process.argv.length - 1]);
const problems = [];
app.whenReady().then(async () => {
  // The shell asks main for the in-app update state at boot. Without main's bridge Electron logs
  // "No handler registered"; answer as a build that cannot update itself, which the UI handles.
  ipcMain.handle("pibot:updates", () => ({
    phase: "idle",
    currentVersion: app.getVersion(),
    installable: false,
    reason: "dev",
    notice: false,
  }));
  // The first frame asks main for the display snapshot, its locale, labels and the live-App gate
  //. Without main's window handler Electron printed "No handler registered" for each; answer
  // as a first start with no cached screen.
  ipcMain.handle("pibot:startup-snapshot", (_event, action) =>
    action === "locale" ? "en" : action === "ready" ? true : null,
  );
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(out, "preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.on("console-message", (event) => {
    // Where it was thrown: the bundle chunk and line, so a failure points at code, not a guess.
    if (event.level === "error")
      problems.push(
        `console: ${event.message.slice(0, 500)} (${path.basename(event.sourceId ?? "")}:${event.lineNumber ?? "?"})`,
      );
  });
  win.webContents.on("render-process-gone", (_event, details) =>
    problems.push(`renderer gone: ${details.reason}`),
  );
  try {
    await win.loadFile(path.join(out, "renderer/index.html"));
  } catch (error) {
    problems.push(`load failed: ${error.message}`);
  }
  // The shell renders its starting state without a brain; give React and lazy chunks a moment.
  setTimeout(async () => {
    const length = await win.webContents
      .executeJavaScript("document.getElementById('root')?.innerHTML.length ?? 0")
      .catch(() => 0);
    if (!length) problems.push("empty #root");
    for (const line of problems) console.error(line);
    console.log(problems.length ? "renderer smoke: FAILED" : "renderer smoke: ok");
    app.exit(problems.length ? 1 : 0);
  }, 4000);
});
