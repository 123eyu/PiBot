import { app, BrowserWindow } from "electron";

/** No data directory, owner, RPC, preload or network is opened by this short-lived process. */
export async function probeChromiumSandbox() {
  const directory = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
  if (!directory) throw new Error("sandbox_probe_directory_missing");
  app.setPath("userData", directory);
  app.enableSandbox();
  app.commandLine.appendSwitch("disable-setuid-sandbox");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL("data:text/html,<title>Pi Bot sandbox probe</title>");
    process.stdout.write("pibot_chromium_sandbox_ready\n");
  } finally {
    window.destroy();
  }
}
