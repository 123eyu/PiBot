// Schema fixtures for the computer / browser / skills / teach contracts. Kept beside the shared
// table in schemas.test.ts so parallel changes append one spread line instead of large blocks.
import type {
  ComputerBlocklistEntry,
  ComputerGrant,
  ComputerPermissions,
  ComputerState,
  HostComputerGuardMethod,
} from "@pibot/protocol-base";
import type {
  EventPayloads,
  HostParams,
  HostResults,
  MethodParams,
  MethodResults,
} from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const ok = { ok: true } as const;
const thumbnail = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/jpeg" } as const;
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
const always = { botId: id, apps: [keynote], updatedAt: date };
const blocked: ComputerBlocklistEntry = {
  appId: "com.tencent.xinWeChat",
  name: "WeChat",
  source: "default",
  removable: true,
};
const step = {
  id,
  botId: id,
  runId: id,
  toolCallId: "call-1",
  app: keynote,
  method: "ui",
  stage: "background",
  target: "Insert table",
  result: "done",
  hasScreenshot: true,
  createdAt: date,
} as const;
const state: ComputerState = {
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
const permissions: ComputerPermissions = {
  platform: "darwin",
  available: true,
  unavailableReason: null,
  items: [
    { kind: "accessibility", status: "granted" },
    { kind: "automation", status: "unknown" },
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
// Indicator / shortcut / automation warm-up host calls (brain → background process).
const guardEntry = {
  botId: id,
  runId: id,
  botName: "Writer",
  apps: ["Keynote"],
  mode: "background" as const,
  pausedBy: null,
  step: null,
  confirm: null,
};

export const computerMethodCases = {
  "computer.grant.resolve": {
    params: {
      approvalId: id,
      decision: "allow",
      apps: [keynote.id],
      duration: "task",
      foregroundAsk: true,
      allowCoordinates: true,
    },
    result: { ok: true, grant },
    badParams: { approvalId: id, decision: "allow", apps: [], duration: "task" },
    badResult: { ok: true, grant: { ...grant, token: "secret" } },
  },
  "computer.grants": {
    params: { botId: id },
    result: [grant],
    badParams: { limit: 201 },
    badResult: [{ ...grant, apps: [] }],
  },
  "computer.stop": { params: { botId: id }, result: ok, badParams: {}, badResult: {} },
  "computer.pause": { params: { botId: id }, result: ok, badParams: {}, badResult: {} },
  "computer.resume": { params: { botId: id }, result: ok, badParams: {}, badResult: {} },
  "computer.handoff.resolve": {
    params: { id, action: "continue" },
    result: ok,
    badParams: { id, action: "retry" },
    badResult: { ok: false },
  },
  "computer.foreground.resolve": {
    params: { requestId: id, allow: true },
    result: ok,
    badParams: { requestId: id },
    badResult: { ok: false },
  },
  "computer.status": {
    params: undefined,
    result: [state],
    badParams: { botId: 1 },
    badResult: [{ ...state, state: "busy" }],
  },
  "computer.permissions": {
    params: undefined,
    result: permissions,
    badParams: { platform: "darwin" },
    badResult: { ...permissions, platform: "android" },
  },
  "computer.openSystemSettings": {
    params: { pane: "screen" },
    result: ok,
    badParams: { pane: "privacy" },
    badResult: {},
  },
  "computer.always.get": {
    params: { botId: id },
    result: always,
    badParams: {},
    badResult: { ...always, apps: [] },
  },
  "computer.always.set": {
    params: { botId: id, apps: [keynote] },
    result: always,
    badParams: { botId: id, apps: [keynote, { ...keynote, id: keynote.id.toUpperCase() }] },
    badResult: { ...always, allowCoordinates: true },
  },
  "computer.always.clear": { params: { botId: id }, result: ok, badParams: {}, badResult: {} },
  "computer.blocklist.list": {
    params: undefined,
    result: [blocked],
    badParams: { all: true },
    badResult: [{ ...blocked, source: "system" }],
  },
  "computer.blocklist.add": {
    params: { app: keynote },
    result: { ...blocked, source: "user" },
    badParams: { app: { id: "a/b", name: "Bad" } },
    badResult: { ...blocked, removable: "yes" },
  },
  "computer.blocklist.remove": {
    params: { appId: blocked.appId },
    result: ok,
    badParams: { appId: "" },
    badResult: {},
  },
  "computer.installedApps": {
    params: undefined,
    result: { supported: true, apps: [{ ...keynote, category: "chat" }], truncated: false },
    badParams: { limit: 1 },
    badResult: { supported: true, apps: [{ ...keynote, iconPath: "/a.png" }], truncated: false },
  },
  "computer.settings.get": {
    params: undefined,
    result: { screenshotRetentionDays: 7 },
    badParams: { days: 7 },
    badResult: { screenshotRetentionDays: 0 },
  },
  "computer.settings.set": {
    params: { screenshotRetentionDays: 14 },
    result: { screenshotRetentionDays: 14 },
    badParams: { screenshotRetentionDays: 31 },
    badResult: {},
  },
  "computer.steps": {
    params: { runId: id, limit: 50 },
    result: [step],
    badParams: { limit: 0 },
    badResult: [{ ...step, method: "mouse" }],
  },
  "computer.screenshot.thumbnail": {
    params: { stepId: id },
    result: thumbnail,
    badParams: { stepId: "bad" },
    badResult: { ...thumbnail, mimeType: "image/gif" },
  },
  "computer.screenshot.view": {
    params: { stepId: id },
    result: thumbnail,
    badParams: {},
    badResult: { ...thumbnail, mimeType: "image/bmp" },
  },
} satisfies Cases<
  Exclude<
    Extract<keyof MethodParams, `${"computer"}.${string}`>,
    "browser.debug" | "browser.inspectPoint"
  >
>;

export const computerEventCases = {
  "computer.step": { payload: { step }, bad: { step: { ...step, target: "a\u0007" } } },
  "computer.state": { payload: state, bad: { ...state, screenLocked: undefined } },
} satisfies {
  [K in Extract<keyof EventPayloads, `${"computer"}.${string}`>]: {
    payload: EventPayloads[K];
    bad: unknown;
  };
};

export const computerHostGuardCases = {
  "host.computerGuard.update": {
    params: { language: "zh", entries: [guardEntry] },
    result: null,
    badParams: { language: "zh", entries: [{ ...guardEntry, mode: "busy" }] },
    badResult: {},
  },
  "host.computerGuard.actions": {
    params: { waitMs: 20_000 },
    result: { actions: [{ kind: "stopAll" }, { kind: "foreground", requestId: id, allow: true }] },
    badParams: { waitMs: 60_000 },
    badResult: { actions: [{ kind: "stop" }] },
  },
  "host.computerGuard.prepareAutomation": {
    params: { apps: [keynote.id] },
    result: { supported: true, triggered: 1 },
    badParams: { apps: [] },
    badResult: { supported: true },
  },
  "host.computerGuard.blocklist": {
    params: { appIds: [blocked.appId] },
    result: null,
    badParams: { appIds: ["a/b"] },
    badResult: {},
  },
} satisfies {
  [K in HostComputerGuardMethod]: {
    params: HostParams[K];
    result: HostResults[K];
    badParams: unknown;
    badResult: unknown;
  };
};
