type BrowserCallback<T> = (value: T) => void;
interface BrowserTab {
  id?: number;
  windowId?: number;
  active?: boolean;
  url?: string;
  title?: string;
  groupId?: number;
  status?: "loading" | "complete" | "unloaded";
}
interface BrowserWindow {
  id?: number;
  focused?: boolean;
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  tabs?: BrowserTab[];
}
interface BrowserGroup {
  id: number;
  title?: string;
  color?: string;
  collapsed?: boolean;
}
interface BrowserPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
interface BrowserNamespace {
  runtime: {
    id: string;
    /** Set inside a callback or listener when the last API call failed; reading it clears it. */
    lastError?: { message?: string };
    connectNative(name: string): BrowserPort;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; tab?: BrowserTab },
          sendResponse: BrowserCallback<unknown>,
        ) => boolean | undefined,
      ): void;
    };
    onInstalled: { addListener(listener: () => void): void };
    onStartup: { addListener(listener: () => void): void };
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    request(permissions: { origins: string[] }): Promise<boolean>;
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number; delayInMinutes?: number }): Promise<void>;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  windows: {
    create(options: { focused: boolean; type?: "normal" }): Promise<BrowserWindow>;
    update(
      windowId: number,
      options: { focused?: boolean; state?: "normal" },
    ): Promise<BrowserWindow>;
    remove(windowId: number): Promise<void>;
    get(windowId: number): Promise<BrowserWindow>;
    getLastFocused(): Promise<BrowserWindow>;
  };
  tabs: {
    query(query: { windowId?: number; active?: boolean }): Promise<BrowserTab[]>;
    create(options: { windowId: number; url?: string; active: boolean }): Promise<BrowserTab>;
    get(tabId: number): Promise<BrowserTab>;
    onRemoved: { addListener(listener: (tabId: number) => void): void };
    onUpdated: {
      addListener(listener: (tabId: number, change: { status?: string }) => void): void;
      removeListener(listener: (tabId: number, change: { status?: string }) => void): void;
    };
    update(tabId: number, options: { active?: boolean; url?: string }): Promise<BrowserTab>;
    remove(tabId: number): Promise<void>;
    captureVisibleTab(
      windowId: number,
      options?: { format?: "png" | "jpeg"; quality?: number },
    ): Promise<string>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    group?(options: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    goBack(tabId: number): Promise<void>;
  };
  tabGroups?: {
    get(groupId: number): Promise<BrowserGroup>;
    query(query: { windowId?: number }): Promise<BrowserGroup[]>;
    update(
      groupId: number,
      options: { title?: string; color?: string; collapsed?: boolean },
    ): Promise<BrowserGroup>;
  };
  action: {
    setBadgeText(options: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor(options: { color: string; tabId?: number }): Promise<void>;
  };
  scripting: {
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
  };
}
declare const chrome: BrowserNamespace;
declare const __PIBOT_BROWSER__: "chrome" | "edge" | "firefox";
declare const __PIBOT_VERSION__: string;
