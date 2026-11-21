/*
 * Shared pieces of the built-in update flow: the target types, the dependencies the apply step
 * calls back into, the protocol errors every path throws, and the audit line).
 */
import type { DatabaseSync } from "node:sqlite";
import type { SkillsPort } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import {
  type Bot,
  type Events,
  type Group,
  type MethodParams,
  type Methods,
  type ModelInfo,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import { AuditRepo } from "@pibot/storage";
import type { BuiltinChange } from "@pibot/teams-contract";
import type { BuiltinService } from "../service.ts";

export type Target = { botId: string } | { groupId: string };
export type Apply = MethodParams["builtin.update.apply"];
export type Language = "zh" | "en";

export interface BuiltinUpdateDeps {
  db: DatabaseSync;
  peer: Peer<typeof Methods, typeof Events>;
  redactor: Redactor;
  logger: Pick<Logger, "warn">;
  builtin: Pick<BuiltinService, "content" | "createBot" | "existing">;
  skills(): Pick<SkillsPort, "create" | "exportPackages" | "inventory" | "replace" | "remove">;
  bots: { update(params: MethodParams["bots.update"]): Promise<Bot> };
  groups: {
    update(params: MethodParams["groups.update"]): Promise<Group>;
    addMember(groupId: string, botId: string): Promise<Group>;
  };
  permissions: { set(params: MethodParams["permissions.set"]): Promise<unknown> };
  /** The model a Bot uses, when it is available now (local catalog, no request). */
  model(provider: string, id: string): Promise<ModelInfo | undefined>;
  language(): "zh" | "en";
}

export const changed = () => new RpcError(RpcErrorCodes.busy, "builtin_update_changed");
/**
 * The error's class name, plus the code when it is a protocol error code: free-form messages can
 * carry ids or paths, but a bare `RpcError` once hid why 小演's update failed.
 */
export const reason = (error: unknown) =>
  error instanceof RpcError && /^[a-z][a-z0-9_]{0,63}$/.test(error.message)
    ? `RpcError:${error.message}`
    : error instanceof Error
      ? error.name
      : typeof error;
export const unavailable = () =>
  new RpcError(RpcErrorCodes.invalidParams, "builtin_update_unavailable");
export const missing = () => new RpcError(RpcErrorCodes.invalidParams, "builtin_restore_missing");
/** Counts only, for the audit line; never names or text. */
export const counts = (changes: BuiltinChange[], kept: BuiltinChange[]) =>
  [
    ...[
      "norms",
      "thinking",
      "permission",
      "skill",
      "announcement",
      "coordinator",
      "roundLimit",
      "member",
    ].map((item) => `${item}=${changes.filter((line) => line.item === item).length}`),
    `kept=${kept.length}`,
  ].join(" ");

export function audit(
  deps: BuiltinUpdateDeps,
  botId: string,
  detail: Record<string, unknown>,
  summary: string,
) {
  new AuditRepo(deps.db, deps.redactor).append({
    botId,
    kind: "builtin.updated",
    summary,
    detail: { actor: "user", ...detail },
  });
}
