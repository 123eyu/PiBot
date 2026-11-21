import { contextBridge, ipcRenderer } from "electron";

const channel = process.argv
  .find((arg) => arg.startsWith("--office-render-channel="))
  ?.split("=")[1];
if (channel) {
  contextBridge.exposeInMainWorld("officePageRenderer", {
    request: () => ipcRenderer.invoke(channel),
    finish: (result: unknown) => ipcRenderer.send(`${channel}:result`, result),
  });
}
