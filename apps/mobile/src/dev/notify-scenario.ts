import { base64url } from "@pibot/link";
import { sealPushRoute } from "@pibot/link/room";
import type { EventPayloads } from "@pibot/protocol";
import {
  addMember,
  removeGroupMemory,
  removeMember,
  removeMemory,
} from "../features/settings/calls.ts";
import { decide, type Notice, type NoticeContext, noticeText, toNotice } from "../push/decide.ts";
import { SeenEvents } from "../push/seen.ts";
import { unlockCancelled } from "../runtime/errors.ts";
import { unlockError } from "../runtime/unlock-errors.ts";
import { openPushEvent } from "../transport/push-route.ts";

/**
 * Dev probe (`pnpm --filter @pibot/mobile probe --notify`): which events notify, the
 * de-duplication with pushes, nothing for the open chat, privacy of the text, and the unlock gate
 * on memory delete / member removal. The desktop half (its real push sender and the relay's Expo
 * ticket reader) is injected by scripts/notify-probe.mjs; the app never imports desktop code.
 */
export interface NotifyDesktop {
  /** The desktop push sender on one event: the push it would send (route before sealing). */
  push(
    method: string,
    payload: unknown,
  ): Promise<{ kind: "approval" | "run_done" | "run_failed"; route: Record<string, string> }[]>;
  /** Expo answers DeviceNotRegistered: did the desktop clear the stored token? */
  unregistered(sameToken: boolean): Promise<boolean>;
  /** The relay's reading of an Expo push ticket. */
  expoResult(body: unknown): Promise<string>;
}
const BOT = "11111111-1111-4111-8111-111111111111",
  OTHER_BOT = "22222222-2222-4222-8222-222222222222",
  GROUP = "33333333-3333-4333-8333-333333333333",
  TOPIC = "44444444-4444-4444-8444-444444444444",
  APPROVAL = "55555555-5555-4555-8555-555555555555",
  LOGIN = "66666666-6666-4666-8666-666666666666",
  RUN = "77777777-7777-4777-8777-777777777777",
  RUN2 = "88888888-8888-4888-8888-888888888888",
  ROUTINE_RUN = "99999999-9999-4999-8999-999999999999",
  TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Strings that must never reach a notification, a push or the relay in the clear.
const SECRETS = ["SECRET_MESSAGE_BODY", "rm -rf ~/secret-plan.txt", "SECRET_TASK_TITLE", "sk-test"];
const now = new Date().toISOString();
const approval = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    botId: BOT,
    runId: RUN,
    messageId: RUN,
    conversationId: TOPIC,
    status: "pending",
    risk: "danger",
    title: SECRETS[1],
    command: SECRETS[1],
    facts: [{ kind: "program", value: SECRETS[3] }],
    ...extra,
  }) as unknown as EventPayloads["approval.requested"];
type Sample = { name: string; method: Parameters<typeof toNotice>[0]; payload: unknown };
const samples: Sample[] = [
  { name: "approval", method: "approval.requested", payload: approval(APPROVAL) },
  {
    name: "login approval (browser waits for takeover)",
    method: "approval.requested",
    payload: approval(LOGIN, { category: "web", login: { site: {}, accounts: [{}] } }),
  },
  {
    name: "reply done (DM)",
    method: "chat.done",
    payload: { botId: BOT, conversationId: TOPIC, runId: RUN, messageId: RUN, stopReason: "stop" },
  },
  {
    name: "reply failed (group)",
    method: "chat.error",
    payload: {
      groupId: GROUP,
      botId: OTHER_BOT,
      conversationId: TOPIC,
      runId: RUN2,
      messageId: RUN2,
      code: "network",
      message: SECRETS[0],
    },
  },
  {
    name: "reply stopped by the person",
    method: "chat.error",
    payload: { botId: BOT, runId: RUN2, messageId: RUN2, code: "aborted", message: "" },
  },
  {
    name: "group task thread reply",
    method: "chat.done",
    payload: { groupId: GROUP, threadId: TOPIC, runId: RUN2, messageId: RUN2, stopReason: "stop" },
  },
  {
    name: "execution task done",
    method: "execution.task.changed",
    payload: {
      id: TASK,
      botId: BOT,
      conversationId: TOPIC,
      runId: RUN2,
      title: SECRETS[2],
      status: "done",
      result: SECRETS[0],
      updatedAt: now,
    },
  },
  {
    name: "execution task archived later",
    method: "execution.task.changed",
    payload: { id: TASK, botId: BOT, runId: RUN2, status: "done", archivedAt: now, updatedAt: now },
  },
  {
    name: "routine run failed",
    method: "routine.run",
    payload: {
      routineId: TASK,
      routineRunId: ROUTINE_RUN,
      runId: null,
      botId: BOT,
      status: "timeout",
      conversationId: null,
      messageId: null,
    },
  },
  {
    name: "routine run still running",
    method: "routine.run",
    payload: { routineRunId: ROUTINE_RUN, runId: RUN, botId: BOT, status: "running" },
  },
];
const names = {
  bot: (id: string) => ({ [BOT]: "Ada", [OTHER_BOT]: "Lin" })[id],
  group: (id: string) => (id === GROUP ? "Launch team" : undefined),
};
const phrases: Record<string, string> = {
  noticeApproval: "需要你审批",
  noticeTakeover: "需要你接管浏览器登录",
  noticeReplyDone: "回复好了",
  noticeReplyFailed: "回复出错了",
  noticeTaskDone: "任务完成了",
  noticeTaskFailed: "任务没有完成",
};
const notice = (sample: Sample) =>
  toNotice(sample.method, sample.payload as EventPayloads[typeof sample.method]);
function credential(key: Uint8Array) {
  const other = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return JSON.stringify({
    version: 1,
    seed: other,
    roomKey: base64url(key),
    publicKey: other,
    relay: "wss://relay.example",
  });
}

export async function runNotifyScenario(desktop: NotifyDesktop) {
  const failures: string[] = [];
  const check = (ok: boolean, name: string) => {
    if (!ok) failures.push(name);
  };
  // 1. Events → notices, and the text each would show.
  const table = samples.map((sample) => {
    const item = notice(sample);
    const text = item && noticeText(item, names, (key) => phrases[key] ?? key);
    return {
      event: sample.name,
      id: item?.id ?? null,
      kind: item?.kind ?? null,
      route: item?.route ?? null,
      title: text?.title ?? null,
      body: text?.body ?? null,
    };
  });
  const kinds = table.map((row) => row.kind);
  check(
    JSON.stringify(kinds) ===
      JSON.stringify([
        "approval",
        "takeover",
        "reply_done",
        "reply_failed",
        null,
        null,
        "task_done",
        null,
        "task_failed",
        null,
      ]),
    "event_mapping",
  );
  check(table[1]?.route?.screen === "browser", "takeover_opens_browser");
  // Privacy: only a name and a fixed phrase, nothing from the event.
  const shown = JSON.stringify(table.map((row) => [row.title, row.body]));
  check(!SECRETS.some((secret) => shown.includes(secret)), "notice_text_private");
  check(
    table.every(
      (row) =>
        row.body === null ||
        (Object.values(phrases).includes(row.body) &&
          ["Ada", "Lin", "Launch team", "Pi Bot"].includes(row.title ?? "")),
    ),
    "notice_text_fixed",
  );

  // 2. When a notice shows.
  const [approvalN, , doneN, , , , taskN] = samples.map(notice) as Notice[];
  if (!approvalN || !doneN || !taskN) throw new Error("scenario_samples");
  const seen = new SeenEvents();
  const base: NoticeContext = {
    enabled: true,
    linked: true,
    foreground: true,
    pushRegistered: true,
    seen: (id) => seen.has(id),
  };
  const openChat = { screen: "chat", kind: "bot", id: BOT } as const;
  const decisions = {
    replyOtherChat: decide(doneN, {
      ...base,
      screen: { screen: "chat", kind: "bot", id: OTHER_BOT },
    }),
    replyOpenChat: decide(doneN, { ...base, screen: openChat }),
    replyOpenChatInBackground: decide(doneN, { ...base, foreground: false, screen: openChat }),
    switchOff: decide(doneN, { ...base, enabled: false }),
    notLinked: decide(doneN, { ...base, linked: false }),
    approvalForeground: decide(approvalN, base),
    approvalOnItsScreen: decide(approvalN, {
      ...base,
      screen: { screen: "approval", id: APPROVAL },
    }),
    approvalBackgroundWithPush: decide(approvalN, { ...base, foreground: false }),
    approvalBackgroundWithoutPush: decide(approvalN, {
      ...base,
      foreground: false,
      pushRegistered: false,
    }),
  };
  check(
    JSON.stringify(Object.values(decisions)) ===
      JSON.stringify([
        "show",
        "on_screen",
        "show",
        "disabled",
        "offline",
        "show",
        "on_screen",
        "push_covers",
        "show",
      ]),
    "decisions",
  );
  // One run ends once: the task announces it, the reply of the same run is a duplicate.
  seen.add(taskN.id);
  const sameRun = decide(
    { ...doneN, id: `run_done:${RUN2}` },
    { ...base, screen: { screen: "chat", kind: "bot", id: OTHER_BOT } },
  );
  check(sameRun === "duplicate", "one_run_one_notice");

  // 3. Push ↔ local: the desktop's sealed route opens on the phone to the same event id.
  const key = crypto.getRandomValues(new Uint8Array(32));
  const phoneCredential = credential(key);
  const strangerCredential = credential(crypto.getRandomValues(new Uint8Array(32)));
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const pushIds: { event: string; pushId: string | null; localId: string | null }[] = [];
  for (const sample of samples.slice(0, 5)) {
    const pushes = await desktop.push(sample.method, sample.payload);
    const sent = pushes[0];
    const data = sent && {
      kind: sent.kind,
      route: sealPushRoute(key, JSON.stringify(sent.route), random),
    };
    if (data)
      check(!SECRETS.some((secret) => JSON.stringify(data).includes(secret)), "push_private");
    const opened = data ? openPushEvent(phoneCredential, data) : undefined;
    if (data) check(!openPushEvent(strangerCredential, data), "push_other_key_rejected");
    pushIds.push({
      event: sample.name,
      pushId: opened?.eventId ?? null,
      localId: notice(sample)?.id ?? null,
    });
  }
  // The login card is pushed as a plain approval; stopped replies are not pushed at all.
  check(
    pushIds.every((row) => row.pushId === null || row.pushId === row.localId),
    "push_id_matches_local_id",
  );
  check(pushIds[4]?.pushId === null, "aborted_not_pushed");
  // A push the open app saw first silences the live event, and the other way round.
  const fresh = new SeenEvents();
  if (pushIds[0]?.pushId) fresh.add(pushIds[0].pushId);
  check(decide(approvalN, { ...base, seen: (id) => fresh.has(id) }) === "duplicate", "push_first");

  // 4. Dead tokens.
  const expo = {
    ok: await desktop.expoResult({ data: { status: "ok", id: "ticket" } }),
    dead: await desktop.expoResult({
      data: { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
    }),
    other: await desktop.expoResult({
      data: { status: "error", details: { error: "MessageRateExceeded" } },
    }),
  };
  check(expo.ok === "ok" && expo.dead === "unregistered" && expo.other === "failed", "expo");
  const cleared = {
    sameToken: await desktop.unregistered(true),
    newerToken: await desktop.unregistered(false),
  };
  check(cleared.sameToken && !cleared.newerToken, "token_cleared_only_if_same");

  // 5. Unlock before irreversible settings: nothing is sent unless the phone verified its owner.
  const calls: string[] = [];
  const caller = {
    call: async (method: string) => {
      calls.push(method);
      return {};
    },
  } as never;
  const refuse = (code: string) => async () => {
    throw new Error(code);
  };
  const allow = async () => undefined;
  const gate: Record<
    string,
    { cancelled: string; sentAfterCancel: number; sentAfterUnlock: number }
  > = {};
  for (const [name, run] of Object.entries({
    deleteMemory: (unlock: () => Promise<void>) => removeMemory(caller, BOT, TASK, unlock),
    deleteGroupMemory: (unlock: () => Promise<void>) =>
      removeGroupMemory(caller, GROUP, TASK, unlock),
    removeMember: (unlock: () => Promise<void>) => removeMember(caller, GROUP, BOT, unlock),
  })) {
    calls.length = 0;
    const error = await run(refuse(unlockError("user_cancel"))).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const sentAfterCancel = calls.length;
    await run(allow);
    gate[name] = {
      cancelled: unlockCancelled(error) ? "silent" : "error",
      sentAfterCancel,
      sentAfterUnlock: calls.length - sentAfterCancel,
    };
    check(unlockCancelled(error) && sentAfterCancel === 0 && calls.length === 1, `gate_${name}`);
  }
  calls.length = 0;
  await addMember(caller, GROUP, OTHER_BOT);
  check(calls.join() === "groups.addMember", "add_member_no_unlock");
  const noLock = await removeMemory(
    caller,
    BOT,
    TASK,
    refuse(unlockError("passcode_not_set")),
  ).then(
    () => "sent",
    (cause: Error) => cause.message,
  );
  check(noLock === "unlock_unavailable" && calls.length === 1, "no_screen_lock_refuses");
  const unlockCodes = {
    user_cancel: unlockError("user_cancel"),
    not_enrolled: unlockError("not_enrolled"),
    passcode_not_set: unlockError("passcode_not_set"),
    lockout: unlockError("lockout"),
    authentication_failed: unlockError("authentication_failed"),
  };
  if (failures.length) throw new Error(`notify_scenario_failed:${failures.join(",")}`);
  return { ok: true, table, decisions, sameRun, pushIds, expo, cleared, gate, unlockCodes, noLock };
}
