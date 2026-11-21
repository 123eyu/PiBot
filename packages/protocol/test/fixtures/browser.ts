// Schema fixtures for the computer / browser / skills / teach contracts. Kept beside the shared
// table in schemas.test.ts so parallel changes append one spread line instead of large blocks.
import type {
  ComputerBlocklistEntry,
  ComputerGrant,
  ComputerState,
  Recording,
} from "@pibot/protocol-base";
import type { EventPayloads, MethodParams, MethodResults } from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const ok = { ok: true } as const;
const keynote = { id: "com.apple.iWork.Keynote", name: "Keynote" };
const grant: ComputerGrant = {
  id,
  botId: id,
  runId: id,
  apps: [keynote.id],
  duration: "task",
  expiresAt: date,
  foregroundAsk: true,
  allowCoordinates: false,
  createdAt: date,
  revokedAt: null,
};
const _blocked: ComputerBlocklistEntry = {
  appId: "com.tencent.xinWeChat",
  name: "WeChat",
  source: "default",
  removable: true,
};
const _state: ComputerState = {
  botId: id,
  runId: id,
  state: "foreground",
  app: keynote,
  pausedBy: null,
  foreground: { requestId: id, app: keynote, action: "Drag table", status: "waiting_idle" },
  userActive: false,
  screenLocked: false,
  stepCount: 3,
  grant,
};
const browser = {
  botId: id,
  open: true,
  tabs: [
    { id: "TAB1", url: "https://example.com/", title: "Example", active: true, loading: false },
  ],
  takeover: false,
  viewing: true,
  recording: false,
  lastActivityAt: date,
};
const _recording: Recording = {
  id,
  botId: id,
  status: "review",
  startedAt: date,
  endedAt: date,
  steps: [
    {
      index: 0,
      kind: "type",
      url: "https://example.com/login",
      target: "Password",
      secret: true,
      hasThumbnail: true,
      at: date,
    },
  ],
};

type Cases<K extends keyof MethodParams & keyof MethodResults> = {
  [M in K]: {
    params: MethodParams[M];
    result: MethodResults[M];
    badParams: unknown;
    badResult: unknown;
  };
};

export const browserMethodCases = {
  "browser.view": {
    params: { botId: id, visible: true },
    result: browser,
    badParams: { botId: id },
    badResult: { ...browser, tabs: [{ id: "bad tab" }] },
  },
  "browser.takeover": {
    params: { botId: id, on: true },
    result: browser,
    badParams: { botId: id, on: "yes" },
    badResult: { ...browser, takeover: "yes" },
  },
  "browser.input": {
    params: {
      botId: id,
      tabId: "TAB1",
      event: {
        type: "mouse",
        action: "down",
        x: 1,
        y: 2,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
    },
    result: ok,
    badParams: { botId: id, tabId: "TAB1", event: { type: "text", text: "" } },
    badResult: {},
  },
  "browser.tabs": {
    params: { botId: id },
    result: browser,
    badParams: {},
    badResult: { ...browser, open: 1 },
  },
  "browser.switchTab": {
    params: { botId: id, tabId: "TAB1" },
    result: browser,
    badParams: { botId: id, tabId: "../x" },
    badResult: {},
  },
  "browser.clearData": {
    params: { botId: id },
    result: browser,
    badParams: {},
    badResult: { ...browser, recording: "no" },
  },
  "browser.navigate": {
    params: { botId: id, tabId: "t1", action: "url", url: "example.com" },
    result: browser,
    badParams: { botId: id, tabId: "t1", action: "home" },
    badResult: {},
  },
  "browser.wake": {
    params: { botId: id },
    result: { ...browser, sleeping: true },
    badParams: {},
    badResult: { ...browser, sleeping: "yes" },
  },
  "browser.newTab": {
    params: { botId: id },
    result: browser,
    badParams: { botId: "x" },
    badResult: {},
  },
  "browser.closeTab": {
    params: { botId: id, tabId: "t1" },
    result: browser,
    badParams: { botId: id, tabId: "../t1" },
    badResult: { ...browser, open: "no" },
  },
  "browser.googleCompat.get": {
    params: { botId: id },
    result: { botId: id, enabled: false, enabledAt: null },
    badParams: { conversationId: id },
    badResult: { botId: id, enabled: "no", enabledAt: null },
  },
  "browser.googleCompat.set": {
    params: { botId: id, enabled: true },
    result: { botId: id, enabled: true, enabledAt: date },
    badParams: { botId: id },
    badResult: { botId: id, enabled: true },
  },
} satisfies Cases<
  Exclude<
    Extract<keyof MethodParams, `${"browser"}.${string}`>,
    "browser.debug" | "browser.inspectPoint"
  >
>;

export const browserEventCases = {
  "browser.state": { payload: browser, bad: { ...browser, tabs: undefined } },
  "browser.googleCompat.changed": {
    payload: { botId: id, enabled: false, enabledAt: null },
    bad: { botId: id, enabled: false },
  },
} satisfies {
  [K in Extract<keyof EventPayloads, `${"browser"}.${string}`>]: {
    payload: EventPayloads[K];
    bad: unknown;
  };
};

/** host.browser.view.* fixtures, spread into the host table in schemas.test.ts. */
export function browserViewHostCases() {
  const view = {
    open: true,
    tabs: [{ tab: "t1", url: "https://example.com/", title: "E", active: true, loading: false }],
    takeover: false,
    viewing: true,
    recording: false,
  };
  const badView = { ...view, tabs: [{ ...view.tabs[0], tab: "TAB1" }] };
  const viewCase = <P>(params: P, badParams: unknown) => ({
    params,
    result: view,
    badParams,
    badResult: badView,
  });
  return {
    "host.browser.userOpen": {
      params: { botId: id, url: "https://example.com/" },
      result: {
        tab: "t1",
        url: "https://example.com/",
        title: "E",
        loading: false,
        blocked: [],
      },
      badParams: { botId: id },
      badResult: null,
    },
    "host.browser.handoff": {
      params: { botId: id, runId: id },
      result: null,
      badParams: { botId: id },
      badResult: {},
    },
    "host.browser.quiesce": {
      params: { botId: id, runId: id },
      result: null,
      badParams: { botId: id },
      badResult: {},
    },
    "host.browser.view.state": viewCase({ botId: id }, {}),
    "host.browser.view.visible": viewCase(
      { botId: id, visible: true, display: { width: 440, height: 600, scale: 2 } },
      { botId: id, visible: true, display: { width: 0, height: 600, scale: 2 } },
    ),
    "host.browser.view.takeover": viewCase({ botId: id, on: false }, { botId: id, on: 1 }),
    "host.browser.view.input": {
      params: { botId: id, tab: "t1", event: { type: "text" as const, text: "a" } },
      result: null,
      badParams: { botId: id, tab: "t1", event: { type: "text", text: "" } },
      badResult: {},
    },
    "host.browser.view.switchTab": viewCase({ botId: id, tab: "t2" }, { botId: id, tab: "TAB1" }),
    "host.browser.clearData": {
      params: { botId: id },
      result: null,
      badParams: { botId: "x" },
      badResult: {},
    },
    "host.browser.clearGroupData": {
      params: { groupId: id },
      result: null,
      badParams: { groupId: "bad" },
      badResult: { ok: true },
    },
    "host.browser.view.navigate": viewCase(
      { botId: id, tab: "t1", action: "back" as const },
      { botId: id, tab: "t1", action: "home" },
    ),
    "host.browser.view.closeTab": viewCase({ botId: id, tab: "t1" }, { botId: id, tab: "TAB1" }),
    "host.browser.view.wake": viewCase({ botId: id }, {}),
    // Fixtures only, so the "every method has a fixture" check covers the phone pull.
    "host.browser.view.remoteFrame": {
      params: { botId: id, after: 0, waitMs: 4000 },
      result: { view, frame: { seq: 1, tab: "t1", width: 1280, height: 800, data: "/9j/" } },
      badParams: { botId: id, after: 0, waitMs: 60_000 },
      badResult: { view, frame: { seq: 1, tab: "t1", width: 1280, height: 800, data: "%%" } },
    },
    "host.browser.view.remoteStop": {
      params: { botId: id },
      result: null,
      badParams: { botId: "x" },
      badResult: {},
    },
    "host.browser.view.newTab": viewCase({ botId: id }, { botId: "x" }),
  };
}

// The user's own browser (settings status, preference, fallback notice; desktop host side).
const extensionStatus = {
  defaultBrowser: { id: "chrome" as const, name: "Google Chrome" },
  supported: true,
  extension: "connected" as const,
  preference: "user" as const,
};
export const browserExtensionMethodCases = {
  "browserExtension.status": {
    params: undefined,
    result: extensionStatus,
    badParams: { verbose: true },
    badResult: { ...extensionStatus, extension: "maybe" },
  },
  "browserExtension.setPreference": {
    params: { preference: "bot" as const },
    result: { ...extensionStatus, preference: "bot" as const },
    badParams: { preference: "safari" },
    badResult: { ...extensionStatus, preference: undefined },
  },
  "browserExtension.fallback": {
    params: { botId: id, runId: id },
    result: { ok: true as const },
    badParams: { botId: id },
    badResult: { ok: false },
  },
  "browserExtension.record": {
    params: {
      botId: id,
      runId: id,
      browser: "chrome" as const,
      action: "open",
      domain: "example.com",
    },
    result: { ok: true as const },
    badParams: { botId: id, browser: "", action: "open", domain: "example.com" },
    badResult: { ok: false },
  },
};
export const browserExtensionEventCases = {
  "browserExtension.changed": {
    payload: extensionStatus,
    bad: { ...extensionStatus, supported: "yes" },
  },
};
export const browserExtensionHostCases = {
  "host.browser.extensionStatus": {
    params: undefined,
    result: { defaultBrowser: null, supported: false, extension: "unsupported" as const },
    badParams: { all: true },
    badResult: {
      defaultBrowser: null,
      supported: false,
      extension: "unsupported",
      preference: "user",
    },
  },
  "host.browser.extensionRegister": {
    params: { enabled: true },
    result: null,
    badParams: { enabled: "yes" },
    badResult: { ok: true },
  },
};
