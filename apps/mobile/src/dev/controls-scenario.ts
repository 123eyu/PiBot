import { RpcError } from "@pibot/protocol";
import {
  navigate,
  nextFrame,
  readBrowserTabs,
  sendInput,
  setTakeover,
  stopWatching,
} from "../features/browser/calls.ts";
import {
  answerQuestion,
  appendToRun,
  cancelCompact,
  compact,
  createTopic,
  listTopics,
  previewRetry,
  readBudget,
  readChanges,
  readMode,
  readPlan,
  readWorkplace,
  readYolo,
  restoreFile,
  retryFrom,
  setMode,
  setWorkplace,
  setYolo,
  switchTopic,
} from "../features/chat/controls/calls.ts";
import type { ChatScope } from "../features/chat/controls/scope.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";
import type { PhoneGate } from "./fixture-controls.ts";
import { createDevLink } from "./fixture-link.ts";

function memoryStorage() {
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>();
  const data: LocalData = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    removePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    close: async () => undefined,
  };
  const secure: SecretData = {
    get: async (id) => secrets.get(id) ?? null,
    set: async (id, value) => void secrets.set(id, value),
    remove: async (id) => void secrets.delete(id),
  };
  return new MobileStorage(data, secure, memoryBlobFiles());
}
async function refusal(work: Promise<unknown>) {
  try {
    await work;
    return "accepted";
  } catch (error) {
    return error instanceof RpcError
      ? `${error.code}:${error.message}`
      : String((error as Error).message);
  }
}
/**
 * Drives every chat control through the in-memory link and reports the RPC methods each
 * one sent. With the desktop's phone gate injected (dev probe), it also proves the whitelist lets
 * them through and still refuses methods and parameters outside it. Memory only; no network.
 */
export async function runControlsScenario(gate?: PhoneGate) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`controls_check_${label}`);
    checks++;
  };
  const fixture = createDevLink(gate),
    runtime = new MobileRuntime(memoryStorage(), fixture.link, 0);
  const controls: Record<string, string[]> = {};
  const track = async (name: string, work: () => Promise<void>) => {
    const start = fixture.calls.length;
    await work();
    controls[name] = fixture.calls.slice(start);
  };
  try {
    await runtime.initialize();
    await runtime.preparePair("development-qr", "Development phone");
    await runtime.savePair();
    const until = Date.now() + 5000;
    while (runtime.getSnapshot().status !== "online") {
      if (Date.now() > until) throw new Error("controls_timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { ids } = fixture;
    const scope: ChatScope = { kind: "bot", id: ids.botId, topicId: ids.topicId };
    await track("topics", async () => {
      check((await listTopics(runtime, "bot", ids.botId)).length === 2, "topics_list");
      check(
        (await switchTopic(runtime, "bot", ids.botId, ids.otherTopicId)) === ids.otherTopicId,
        "switch",
      );
      check(!!(await createTopic(runtime, "bot", ids.botId)), "create");
      await switchTopic(runtime, "bot", ids.botId, ids.topicId);
    });
    await track("workplace", async () => {
      check((await readWorkplace(runtime, scope)).folders.length === 1, "folders");
      await setWorkplace(runtime, scope, ids.folderId);
      check(fixture.controls.folder === ids.folderId, "folder_set");
    });
    await track("plan", async () =>
      check((await readPlan(runtime, scope)).items.length === 2, "plan"),
    );
    await track("sendMode", async () => {
      const current = await readMode(runtime, scope);
      check((await setMode(runtime, scope, "plan", current.version)).mode === "plan", "mode");
    });
    await track(
      "steer",
      async () =>
        void (await appendToRun(runtime, scope, ids.runId, "steer", "Look at the README first")),
    );
    await track(
      "queue",
      async () => void (await appendToRun(runtime, scope, ids.runId, "followUp", "Then summarize")),
    );
    await track("stop", async () => void (await runtime.call("chat.abort", { runId: ids.runId })));
    await track("retry", async () => {
      const plan = await previewRetry(runtime, scope, crypto.randomUUID());
      check(
        (await retryFrom(runtime, scope, crypto.randomUUID(), plan.hash)).state === "pending",
        "retry",
      );
    });
    await track(
      "question",
      async () => void (await answerQuestion(runtime, crypto.randomUUID(), "a")),
    );
    await track("compact", async () => {
      const request = crypto.randomUUID();
      await compact(runtime, scope, request);
      await cancelCompact(runtime, scope, request);
    });
    await track("runInfo", async () =>
      check((await readBudget(runtime, scope, ids.runId))?.requests === 3, "budget"),
    );
    await track("changes", async () => {
      const turn = await readChanges(runtime, scope);
      const file = turn.files[0];
      check(file, "changed_file");
      check(
        (await restoreFile(runtime, scope, turn, file?.path ?? "")).state === "done",
        "restore",
      );
      check((await readChanges(runtime, scope)).files.length === 0, "restored");
    });
    await track("yolo", async () => {
      check(!(await readYolo(runtime, scope)).enabled, "yolo_off");
      check((await setYolo(runtime, scope, true)).enabled, "yolo_on");
      check(!(await setYolo(runtime, scope, false)).enabled, "yolo_off_again");
    });
    // Watch, take over, tap / type / scroll / keys, navigate, hand back, leave.
    await track("browser", async () => {
      const target = { botId: ids.botId };
      check((await readBrowserTabs(runtime, target)).open, "browser_open");
      const view = await nextFrame(runtime, target, 0);
      const frame = view.frame;
      check(frame, "browser_frame");
      if (!frame) return;
      check((await setTakeover(runtime, target, true, ids.topicId)).takeover, "browser_takeover");
      await sendInput(runtime, target, frame, { type: "tap", x: 0.5, y: 0.25 });
      await sendInput(runtime, target, frame, { type: "text", text: "typed" });
      await sendInput(runtime, target, frame, {
        type: "scroll",
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 400,
      });
      await sendInput(runtime, target, frame, { type: "key", key: "Enter" });
      await navigate(runtime, target, frame.tabId, "url", "https://example.com/next");
      await navigate(runtime, target, frame.tabId, "forward", undefined);
      check(!(await setTakeover(runtime, target, false, undefined)).takeover, "browser_hand_back");
      await stopWatching(runtime, target);
    });
    const { limits } = await readMode(runtime, scope);
    // Thunks: each request starts only when awaited, so no rejection is ever left unobserved.
    const outside: [string, () => Promise<unknown>][] = [
      ["workplaces.add", () => runtime.call("workplaces.add", { botId: ids.botId })],
      ["settings.get", () => runtime.call("settings.get", undefined)],
      ["browser.clearData", () => runtime.call("browser.clearData", { botId: ids.botId })],
      [
        "browser.input",
        () =>
          runtime.call("browser.input", {
            botId: ids.botId,
            tabId: "t1",
            event: { type: "text", text: "x" },
          }),
      ],
      // The phone may open Bot settings; archiving a Bot stays on the computer.
      ["bots.archive", () => runtime.call("bots.archive", { botId: ids.botId })],
      [
        "execution.set+limits",
        () =>
          runtime.call("execution.set", {
            botId: ids.botId,
            conversationId: ids.topicId,
            expectedVersion: 2,
            mode: "execute",
            limits,
          }),
      ],
      [
        "groups.topics.create+selectFolder",
        () =>
          runtime.call("groups.topics.create", {
            groupId: crypto.randomUUID(),
            selectFolder: true,
          }),
      ],
    ];
    const refused: Record<string, string> = {};
    for (const [name, work] of outside) refused[name] = await refusal(work());
    if (gate)
      check(
        Object.values(refused).every((outcome) => outcome !== "accepted"),
        "refused",
      );
    await runtime.setForeground(false);
    const before = fixture.calls.length;
    const offline = {
      yolo: await refusal(setYolo(runtime, scope, true)),
      restore: await refusal(readChanges(runtime, scope)),
      mode: await refusal(setMode(runtime, scope, "execute", 2)),
    };
    check(
      fixture.calls.length === before &&
        (await runtime.storage.outbox(fixture.computer.id)).length === 0,
      "offline_not_queued",
    );
    const allowed = gate
      ? [...new Set(Object.values(controls).flat())].every((m) => gate.isPhoneMethod(m))
      : null;
    if (gate) check(allowed, "allowed");
    return { checks, gated: !!gate, controls, allowed, refused, offline, networkRequests: 0 };
  } finally {
    await runtime.dispose();
    fixture.disconnect();
  }
}
