import { contextBridge, ipcRenderer } from "electron";

const channel = process.argv.find((arg) => arg.startsWith("--attachment-channel="))?.split("=")[1];
if (channel) {
  contextBridge.exposeInMainWorld("attachmentConverter", {
    request: () => ipcRenderer.invoke(channel),
    finish: (result: unknown) => ipcRenderer.send(`${channel}:result`, result),
  });
}
