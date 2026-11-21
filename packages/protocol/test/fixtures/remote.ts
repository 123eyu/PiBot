const id = "00000000-0000-4000-8000-000000000001";
const expiresAt = "2026-10-21T00:00:00.000Z";
const settings = {
  enabled: false,
  relay: "official",
  relayUrl: null,
  desktopName: "Pi Bot",
  keepAwake: false,
  direct: { mode: "lan", stunUrl: "stun:stun.cloudflare.com:3478" },
  lanDiscovery: true,
  version: 0,
} as const;
const state = {
  reason: "off",
  onlineDevices: 0,
  pairingAvailable: false,
  keepAwake: "off",
} as const;
const browserState = {
  botId: id,
  open: true,
  tabs: [{ id: "t1", url: "https://example.com/", title: "E", active: true, loading: false }] as {
    id: string;
    url: string;
    title: string;
    active: boolean;
    loading: boolean;
  }[],
  takeover: false,
  viewing: true,
  recording: false,
  lastActivityAt: null,
} as const;
const device = {
  id,
  name: "Phone",
  kind: "phone",
  createdAt: expiresAt,
  lastSeenAt: null,
  revokedAt: null,
  online: false,
  path: "relay",
} as const;
const endpointRow = {
  endpointId: "local",
  capabilityId: "desktop.computer",
  version: 1,
  state: "user_on",
  availability: "available",
  firstSeenAt: expiresAt,
  lastSeenAt: expiresAt,
  lastCalledAt: null,
  scope: { botIds: null, groupIds: null },
} as const;
export const remoteMethodCases = {
  "remote.runnerControl.get": {
    params: { phoneId: id },
    result: { items: [] as never[], nextAfter: null },
    badParams: {},
    badResult: {},
  },
  "remote.runnerControl.set": {
    params: { phoneId: id, runnerDeviceId: id, enabled: false, expectedRevision: 0 },
    result: { ok: true },
    badParams: {},
    badResult: {},
  },
  "remote.runnerControl.pull": {
    params: {},
    result: { grants: [] as never[], nextAfter: null },
    badParams: { extra: true },
    badResult: {},
  },
  "endpoints.list": {
    params: {},
    result: {
      items: [] as import("../../src/aggregate/api.ts").MethodResults["endpoints.list"]["items"],
      nextAfter: null,
    },
    badParams: { limit: 0 },
    badResult: { items: [] },
  },
  "endpoints.capability.set": {
    params: {
      endpointId: "local",
      capabilityId: "desktop.computer",
      enabled: true,
      scope: { botIds: null, groupIds: null },
    },
    result: endpointRow,
    badParams: { endpointId: "local" },
    badResult: { ...endpointRow, state: "unknown" },
  },
  "devices.runnerPair": {
    params: { code: "23456-789AB-CDEFG-HJKLM-NPQRS" },
    result: { ok: true },
    badParams: { code: "" },
    badResult: {},
  },
  "remote.settings.get": {
    params: undefined,
    result: settings,
    badParams: { extra: true },
    badResult: {},
  },
  "remote.settings.set": {
    params: { expectedVersion: 0, patch: { enabled: false } },
    result: settings,
    badParams: { expectedVersion: -1, patch: {} },
    badResult: {},
  },
  "remote.status": { params: undefined, result: state, badParams: { extra: true }, badResult: {} },
  "devices.pairStart": {
    params: undefined,
    result: { id, payload: "fixture", expiresAt },
    badParams: { extra: true },
    badResult: {},
  },
  "devices.pairStatus": {
    params: { id },
    result: { id, expiresAt, status: "waiting" },
    badParams: {},
    badResult: {},
  },
  "devices.pairCancel": { params: { id }, result: { ok: true }, badParams: {}, badResult: {} },
  "devices.endpoints": {
    params: {},
    result: {
      items: [] as import("../../src/aggregate/api.ts").MethodResults["devices.endpoints"]["items"],
      nextAfter: null,
    },
    badParams: { limit: 0 },
    badResult: {},
  },
  "devices.list": {
    params: {},
    result: { items: [] as (typeof device)[], nextAfter: null },
    badParams: { limit: 0 },
    badResult: {},
  },
  "devices.rename": {
    params: { id, name: "Phone" },
    result: device,
    badParams: { id, name: "" },
    badResult: {},
  },
  "devices.revoke": { params: { id }, result: { ok: true }, badParams: {}, badResult: {} },
  "devices.self": {
    params: undefined,
    result: {
      desktopId: id,
      desktopName: "Pi Bot",
      deviceId: id,
      deviceName: "Phone",
      direct: settings.direct,
      lanAddresses: [] as string[],
    },
    badParams: { extra: true },
    badResult: {},
  },
  "remote.session.update": {
    params: { foreground: true, language: "en" },
    result: { ok: true },
    badParams: { foreground: true, language: "unknown" },
    badResult: {},
  },
  "remote.preview.read": {
    params: { attachmentId: id, messageId: id, offset: 0 },
    result: {
      kind: "code",
      revision: "a".repeat(64),
      encoding: "utf8",
      total: 4,
      offset: 0,
      chunk: "text",
      unchanged: false,
    },
    badParams: { attachmentId: id, messageId: id, offset: 10 },
    badResult: {},
  },
  // Fixtures only, so the "every method has a fixture" check covers the phone browser.
  "remote.browser.frame": {
    params: { botId: id, after: 0 },
    result: {
      state: browserState,
      frame: { seq: 1, tabId: "t1", width: 1280, height: 800, data: "/9j/" },
      mine: false,
    },
    badParams: { botId: id, after: -1 },
    badResult: { state: browserState, frame: { seq: 0 } },
  },
  "remote.browser.stop": {
    params: { botId: id },
    result: { ok: true },
    badParams: {},
    badResult: {},
  },
  "remote.browser.takeover": {
    params: { botId: id, on: true },
    result: browserState,
    badParams: { botId: id, on: "yes" },
    badResult: { ...browserState, takeover: "yes" },
  },
  "remote.browser.input": {
    params: { botId: id, tabId: "t1", seq: 1, event: { type: "tap", x: 0.5, y: 0.25 } },
    result: { ok: true },
    badParams: { botId: id, tabId: "t1", seq: 1, event: { type: "tap", x: 2, y: 0 } },
    badResult: {},
  },
  "remote.browser.navigate": {
    params: { botId: id, tabId: "t1", action: "forward" },
    result: browserState,
    badParams: { botId: id, tabId: "t1", action: "home" },
    badResult: {},
  },
  "remote.share.upload": {
    params: {
      kind: "image",
      name: "a.png",
      mimeType: "image/png",
      total: 8,
      offset: 0,
      chunk: "iVBO",
    },
    result: { uploadId: id, received: 4 },
    badParams: {
      kind: "image",
      name: "a.png",
      mimeType: "image/png",
      total: 8,
      offset: 4,
      chunk: "iVBO",
    },
    badResult: {},
  },
  "remote.phoneData.state": {
    params: { platform: "android", media: true, smsCode: false },
    result: { ok: true },
    badParams: { platform: "web", media: true, smsCode: false },
    badResult: {},
  },
  "remote.offline.manifest": {
    params: { keys: [] as never[] },
    result: { version: "0123456789abcdef", keys: [] as never[] },
    badParams: { keys: [{ grantId: id, digest: "not-hex" }] },
    badResult: { version: "x", keys: [] as never[] },
  },
  "remote.offline.snapshot": {
    params: { botId: id },
    result: {
      botId: id,
      version: "0123456789abcdef",
      grantId: id,
      language: "en",
      systemPrompt: "You are Pi.",
      reference: "",
      tools: [] as never[],
    },
    badParams: { botId: "x" },
    badResult: { botId: id },
  },
  "remote.offline.upload": {
    params: {
      localTopicId: id,
      botId: id,
      grantId: id,
      providerId: "openai",
      modelId: "gpt",
      part: 0,
      final: true,
      messages: [] as never[],
      audit: [] as never[],
      memory: [] as never[],
      egress: [] as never[],
    },
    result: { topicId: id, imported: 0, duplicates: 0 },
    badParams: { localTopicId: id },
    badResult: { topicId: id },
  },
  "remote.offline.get": {
    params: { deviceId: id },
    result: { deviceId: id, models: [] as never[], bots: [] as never[], pending: false },
    badParams: {},
    badResult: { deviceId: id },
  },
  "remote.offline.set": {
    params: { deviceId: id, bot: { botId: id, offline: false } },
    result: { deviceId: id, models: [] as never[], bots: [] as never[], pending: false },
    badParams: { deviceId: id, models: [] as never[] },
    badResult: {},
  },
} as const;
export const remoteEventCases = {
  "remote.offline.changed": { payload: {}, bad: { clear: false } },
  "endpoints.changed": { payload: {}, bad: { extra: true } },
  "devices.changed": { payload: {}, bad: { extra: true } },
  "remote.state": { payload: state, bad: { ...state, onlineDevices: -1 } },
  "remote.interactive": { payload: { interactive: "quit" }, bad: { interactive: "closed" } },
} as const;
