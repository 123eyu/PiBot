import type { Methods } from "@pibot/protocol";

/**
 * Maintainers 2026-11-20 (v0.0.3): the phone's To-dos tab. These are the user's own to-dos and the
 * same brain methods the desktop inbox calls, so a change on either side reaches the other through
 * the already allowed `inbox.changed`. Every write is still audited by the brain
 * (`personal_todo.changed`) and by the phone gateway; delete keeps its `confirmed: true`.
 */
export const todoPhoneMethods = [
  "personalTodos.list",
  "personalTodos.counts",
  "personalTodos.undatedCount",
  "personalTodos.create",
  "personalTodos.update",
  "personalTodos.setStatus",
  "personalTodos.delete",
] as const satisfies readonly (keyof typeof Methods)[];
export const todoPhoneReads = [
  "personalTodos.list",
  "personalTodos.counts",
  "personalTodos.undatedCount",
] as const satisfies readonly (typeof todoPhoneMethods)[number][];
