import { type BrowserUiPorts, BrowserUiProvider } from "@pibot/browser/ui";
import { SaveLoginPrompt, TakeoverAccounts } from "@pibot/credentials/ui";
import type { ReactNode } from "react";
import { PopupMenu } from "../features/execution/PopupMenu.tsx";

const ports: BrowserUiPorts = {
  SaveLoginPrompt,
  TakeoverAccounts,
  PopupMenu,
  onBrowserFrames: (callback) => window.pibot.onBrowserFrames(callback),
};
export function BrowserPorts({ children }: { children: ReactNode }) {
  return <BrowserUiProvider ports={ports}>{children}</BrowserUiProvider>;
}
