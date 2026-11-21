// Schema fixtures for the built-in roles / templates contracts, spread into the exhaustive
// method table in schemas.test.ts (no new test cases; the table requires one entry per method).
import type { MethodParams, MethodResults } from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-15T00:00:00.000Z";
type Cases<K extends keyof MethodParams & keyof MethodResults> = {
  [M in K]: {
    params: MethodParams[M];
    result: MethodResults[M];
    badParams: unknown;
    badResult: unknown;
  };
};
const role: MethodResults["builtin.catalog"]["roles"][number] = {
  id: "frontend-dev",
  version: 1,
  category: "engineering",
  name: "前端开发",
  defaultBotName: "小前",
  summary: "做网页和界面",
  persona: "你是前端开发。",
  norms: "- 先看再改",
  avatar: { shape: "hex", color: "blue", eyes: "dot" },
  botCategory: "chat",
  permissionOverrides: { run_command: "ask", send_out: "never" },
  skills: [{ id: "bugfix-flow", name: "修 bug", description: "流程", files: 1, scripts: 1 }],
  quickPrompts: ["看看这个页面"],
  needs: { vision: false, imageGeneration: false },
  autoCheck: true,
};
const bot = {
  id,
  name: "小前",
  isMain: false,
  category: "chat" as const,
  avatarShape: "hex",
  avatarColor: "blue",
  avatarEyes: "dot",
  modelProvider: null,
  modelId: null,
  thinkingLevel: "off" as const,
  systemPrompt: "你是前端开发。",
  createdAt: date,
  updatedAt: date,
  role: { id: "frontend-dev", version: 1 },
  norms: "- 先看再改",
  quickPrompts: ["看看这个页面"],
};
export const builtinMethodCases = {
  "builtin.catalog": {
    params: undefined,
    result: { language: "zh", roles: [role], groups: [], professions: [] },
    badParams: { language: "zh" },
    badResult: {
      language: "zh",
      roles: [{ ...role, permissionOverrides: { send_out: "always" } }],
      groups: [],
      professions: [],
    },
  },
  "builtin.plan": {
    params: {
      groups: ["dev-squad"],
      roles: [],
      professions: [],
      reuseExisting: false,
      duplicate: [],
    },
    result: {
      groups: [],
      bots: [{ roleId: "frontend-dev", name: "小前", groups: [], standalone: true }],
      counts: { groups: 0, newBots: 1, maxGroups: 3, maxBots: 10 },
    },
    badParams: { groups: ["Dev Squad"] },
    badResult: { groups: [], bots: [] },
  },
  "builtin.create": {
    params: {
      groups: [],
      roles: ["frontend-dev"],
      professions: [],
      reuseExisting: true,
      duplicate: [],
      source: "profession",
    },
    result: { botIds: [id], groupIds: [], reusedBotIds: [] },
    badParams: { roles: ["frontend-dev"], source: "import" },
    badResult: { botIds: [id], groupIds: [] },
  },
  "builtin.createBot": {
    params: { roleId: "frontend-dev", name: "小前" },
    result: { bot },
    badParams: { roleId: "frontend-dev", permissionOverrides: { run_command: "always" } },
    badResult: { bot: { ...bot, role: { id: "Frontend", version: 1 } } },
  },
  "builtin.update.preview": {
    params: { botId: id },
    result: {
      kind: "bot",
      state: "available",
      restorable: false,
      sourceId: "ui-ux-designer",
      name: "UI / UX 设计师",
      fromVersion: 1,
      toVersion: 5,
      dismissed: false,
      provenance: "history",
      revision: "0123456789abcdef",
      changes: [
        {
          item: "permission",
          action: "update",
          category: "run_command",
          from: "never",
          to: "default",
        },
      ],
      kept: [],
      members: [],
      quickStarts: [],
    },
    badParams: { botId: id, groupId: id },
    badResult: { kind: "bot" },
  },
  "builtin.update.apply": {
    params: {
      groupId: id,
      toVersion: 4,
      revision: "0123456789abcdef",
      addMembers: ["qa-engineer"],
    },
    result: { ok: true, failed: [] },
    badParams: { botId: id, toVersion: 0, revision: "x" },
    badResult: { ok: false, failed: [] },
  },
  "builtin.update.dismiss": {
    params: { botId: id, version: 5 },
    result: { ok: true },
    badParams: { version: 5 },
    badResult: {},
  },
  "builtin.update.restore": {
    params: { groupId: id },
    result: { ok: true, failed: [] },
    badParams: {},
    badResult: { ok: false, failed: [] },
  },
  "teams.previewFile": {
    params: { previewId: id, ref: "bot-1", skill: "修 bug", path: "scripts/check.py" },
    result: { text: "print(1)" },
    badParams: { previewId: id, ref: "bot-1", skill: "修 bug", path: "" },
    badResult: { text: 1 },
  },
} satisfies Cases<
  | "builtin.catalog"
  | "builtin.plan"
  | "builtin.create"
  | "builtin.createBot"
  | "builtin.update.preview"
  | "builtin.update.apply"
  | "builtin.update.dismiss"
  | "builtin.update.restore"
  | "teams.previewFile"
>;

// The signed role library (catalog state, check, install).
const catalogState: MethodResults["roleCatalog.get"] = {
  status: "ready",
  checkedAt: date,
  error: null,
  entries: [
    {
      kind: "role",
      id: "code-reviewer",
      version: 9,
      name: { zh: "小审", en: "Reva" },
      description: { zh: "只读审查代码", en: "Reviews code read-only" },
      category: "engineering",
      bytes: 11554,
      bundled: 8,
      installed: null,
      needsUpdate: false,
    },
  ],
};
export const roleCatalogMethodCases: Cases<
  "roleCatalog.get" | "roleCatalog.check" | "roleCatalog.install"
> = {
  "roleCatalog.get": {
    params: undefined,
    result: catalogState,
    badParams: { force: true },
    badResult: { ...catalogState, status: "stale" },
  },
  "roleCatalog.check": {
    params: {},
    result: { ...catalogState, status: "unavailable", error: "offline" },
    badParams: { url: "https://example.com" },
    badResult: { ...catalogState, error: "dns" },
  },
  "roleCatalog.install": {
    params: { kind: "group", id: "research-group" },
    result: { ok: true, version: 14 },
    badParams: { kind: "skill", id: "research-group" },
    badResult: { ok: true, version: 0 },
  },
};
