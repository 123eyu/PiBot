import type { ImportDialogs } from "@pibot/plugins/host";
import { type GuiHostMethods, type Peer, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { BrowserWindow, dialog } from "electron";

// The renderer waits 650 s for this picker and the brain asks its host without a short
// deadline, so forwarding to the window must not expire first; the background forwards this value
// instead of its 60 s default.
const GUI_PICK = { timeoutMs: 620_000 };

/** Keep native confirmation attached to its owner without importing Electron into the capability. */
export function connectorImportDialogs(options: {
  dialogs: Pick<typeof dialog, "showOpenDialog" | "showMessageBox">;
  window: () => BrowserWindow | undefined;
  gui?: Pick<Peer<typeof GuiHostMethods, Record<string, never>>, "call">;
}): ImportDialogs {
  const parent = () => {
    const value = options.window();
    return value && !value.isDestroyed() ? value : undefined;
  };
  return {
    async showOpenDialog(request) {
      const owner = parent();
      // The owner process has no window, and a parentless dialog can open behind other
      // windows on Windows while the import panel waits for an answer forever. Ask the window
      // process instead, the same way every other picker does.
      if (!owner) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        const kind = request.properties.includes("openDirectory") ? "plugin-folder" : "plugin-file";
        const path = await options.gui.call("gui.pick", { kind }, GUI_PICK);
        return { canceled: path === null, filePaths: path ? [path] : [] };
      }
      const result = await options.dialogs.showOpenDialog(owner, request);
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
    async showMessageBox(request, signal) {
      signal?.throwIfAborted();
      const owner = parent();
      // Same reason as the picker: the windowless owner asks the window process.
      if (!owner) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        const { type: _type, noLink: _noLink, ...dialogRequest } = request;
        return options.gui.call("gui.confirm", dialogRequest, { timeoutMs: 305_000, signal });
      }
      const result = await options.dialogs.showMessageBox(owner, { ...request, signal });
      return { response: result.response };
    },
  };
}
