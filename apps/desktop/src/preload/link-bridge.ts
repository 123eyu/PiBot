import { ipcRenderer } from "electron";

const channel = process.argv.find((arg) => arg.startsWith("--link-bridge-channel="))?.slice(22);
if (channel && /^pibot:link-bridge-[a-f0-9-]{36}$/.test(channel)) {
  ipcRenderer.once(channel, (event) => {
    const port = event.ports[0];
    if (event.ports.length !== 1 || !port) return;
    // Transfer the capability itself; the page receives no general Electron API.
    window.postMessage("pibot:link-bridge-port", "*", [port]);
  });
  window.addEventListener("DOMContentLoaded", () => ipcRenderer.send(`${channel}:ready`), {
    once: true,
  });
}
