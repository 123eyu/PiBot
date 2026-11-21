// Schema fixtures for the saved-account contracts, spread into schemas.test.ts.
import type { Credential } from "@pibot/protocol-base";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const ok = { ok: true } as const;
const site = "https://example.com";
const credential: Credential = {
  id,
  site,
  label: "al***@example.com",
  note: "",
  botIds: [id],
  hasPassword: true,
  hasTotp: false,
  createdAt: date,
  updatedAt: date,
  lastUsedAt: null,
};
const capture = { botId: id, captureId: id, site, username: "alice@example.com" };
const page = { tab: "t1", url: "https://example.com/", title: "E", loading: false, blocked: [] };

export const credentialMethodCases = {
  "credentials.takeoverAccounts": {
    params: { botId: id },
    result: null,
    badParams: { botId: 1 },
    badResult: { accounts: [] },
  },
  "credentials.fillForTakeover": {
    params: { botId: id, credentialId: id, tab: "t1", documentId: id },
    result: { ok: false as const, code: "no_page" as const },
    badParams: { botId: id, credentialId: id, tab: "t1", documentId: 1 },
    badResult: { ok: true },
  },
  "credentials.status": {
    params: undefined,
    result: { storage: true, reveal: true },
    badParams: { botId: id },
    badResult: { storage: true },
  },
  "credentials.list": {
    params: { botId: id, limit: 50 },
    result: [credential],
    badParams: { limit: 0 },
    badResult: [{ ...credential, password: "x" }],
  },
  "credentials.save": {
    params: { site: "example.com", username: "alice", password: "pw", botIds: [id] },
    result: credential,
    badParams: { site: "example.com", botIds: ["bot"] },
    badResult: { ...credential, site: "https://example.com/login" },
  },
  "credentials.delete": { params: { id }, result: ok, badParams: {}, badResult: {} },
  "credentials.reveal": {
    params: { id },
    result: { username: "alice", password: [112, 119] },
    badParams: { id: "x" },
    badResult: { username: "alice", password: "pw" },
  },
  "credentials.capture.get": {
    params: { botId: id },
    result: capture,
    badParams: {},
    badResult: { ...capture, site: "example.com" },
  },
  "credentials.capture.resolve": {
    params: { botId: id, captureId: id, save: true, botIds: [id] },
    result: { ok: true as const, credential },
    badParams: { botId: id, captureId: id },
    badResult: { ok: true },
  },
  "credentials.login.resolve": {
    params: { approvalId: id, decision: "allow" as const, credentialId: id, remember: true },
    result: ok,
    badParams: { approvalId: id, decision: "allow" },
    badResult: {},
  },
};
export const credentialEventCases = {
  "credentials.changed": { payload: {}, bad: { id } },
  "credentials.capture": { payload: { botId: id, capture }, bad: { botId: id } },
};
export const credentialHostCases = {
  "host.browser.login.takeoverPage": {
    params: { botId: id },
    result: null,
    badParams: { botId: 1 },
    badResult: { page },
  },
  "host.browser.fillLogin": {
    params: { botId: id, site, username: "alice", password: "pw" },
    result: { ok: true as const, username: true, password: true, page },
    badParams: { botId: id, site: "https://example.com/login", username: "a", password: "pw" },
    badResult: { ok: false, code: "wrong" },
  },
  "host.browser.login.capture": {
    params: { botId: id },
    result: { captureId: id, site, username: null },
    badParams: {},
    badResult: { captureId: id, site },
  },
  "host.browser.login.take": {
    params: { botId: id, captureId: id },
    result: { site, username: "alice", password: "pw" },
    badParams: { botId: id },
    badResult: { site, username: "alice", password: "" },
  },
  "host.browser.login.discard": {
    params: { botId: id },
    result: null,
    badParams: {},
    badResult: {},
  },
  "host.credentials.authenticate": {
    params: { reason: "Show the saved password" },
    result: { ok: false, code: "cancelled" as const },
    badParams: { reason: "" },
    badResult: { ok: true, code: "denied" },
  },
};
