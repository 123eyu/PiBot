import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { CacheDiagnostics } from "../../../packages/agent/src/runtime/cache-diagnostic.ts";
import type { Scenario } from "../../../tools/fake-llm/scenario.ts";
import {
  dmDone,
  type Fixture,
  fixture,
  groupIdle,
  sessionEntries,
  until,
} from "../chat/harness.ts";
import {
  type CacheRule,
  firstDifference,
  responsesSections,
  type Section,
  simulateImplicitCache,
} from "./breakpoints.ts";
import { layout, singleMessageLayout, trailingStateLayout, turns } from "./layouts.ts";

type Json = Record<string, unknown>;
interface Variant {
  name: string;
  api: "openai-completions" | "openai-responses";
  compat?: Record<string, boolean>;
}
interface Captured {
  variant: string;
  route: string;
  phase: string;
  body: Json;
}

// The ChatGPT (Codex) and api.openai.com GPT-5.6+ models declare mid-conversation system
// messages; pi-ai then builds the same input items for both, with the system prompt as
// `instructions` (Codex) or a leading developer message (Responses).
const variants: Variant[] = [
  { name: "openai-completions", api: "openai-completions" },
  {
    name: "openai-responses (GPT-5.6+/Codex shape)",
    api: "openai-responses",
    // Codex's flags for gpt-6.1-sol: mid-run tool loads go in place (`additional_tools`).
    compat: {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
      pibotAppendOnlyState: true,
    },
  },
];

const pageA = `# Notes A\n${"Synthetic research note about prompt caching, line A. ".repeat(160)}`;
const pageB = `# Notes B\n${"Synthetic research note about request prefixes, line B. ".repeat(160)}`;

const seedReply = (n: number) =>
  `CACHE-PROBE seed reply ${n}: ${"Synthetic group discussion about cache layouts and shared notes. ".repeat(18)}`;

/** Tool calls the budget run's model keeps making, far beyond the run's tool-call limit. */
const BUDGET_LIMIT = 2;
const BUDGET_CALLS = 6;

function scenario(): Scenario {
  const plan = (version: number, done: number) => ({
    name: "todo_update",
    arguments: {
      expectedVersion: version,
      goal: "Synthetic cache probe",
      items: ["read A", "read B", "summarize"].map((title, i) => ({
        id: `s${i}`,
        title,
        status: i < done ? "done" : i === done ? "in_progress" : "pending",
      })),
    },
  });
  const read = (path: string) => ({ toolCalls: [{ name: "read_file", arguments: { path } }] });
  return {
    replies: [{ text: "未匹配到演练身份。" }],
    routes: {
      researcher: [
        // Run 1: plan, list, two reads, plan update (each plan change is a new state), answer.
        { toolCalls: [plan(0, 0)] },
        { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
        read("notes-a.md"),
        read("notes-b.md"),
        // Closes the plan: open steps would make Pi Bot continue the work in later runs, which
        // would consume the replies scripted for them.
        { toolCalls: [plan(1, 3)] },
        { text: "CACHE-PROBE run 1 answer." },
        // Run 2 in the same topic: loads a tool group mid-run (in place, no full
        // miss), one read, answer.
        { toolCalls: [{ name: "tool_discover", arguments: { groups: ["memory"] } }] },
        read("notes-a.md"),
        { text: "CACHE-PROBE run 2 answer." },
        // Run 3: a plain follow-up, no tools; the group loaded in run 2 stays loaded.
        { text: "CACHE-PROBE run 3 answer." },
        // Budget run: the model ignores every limit and keeps calling tools; the program must
        // stop the run, not the model. Kept last so unused replies cannot shift other runs.
        ...Array.from({ length: BUDGET_CALLS }, () => read("notes-a.md")),
        { text: "CACHE-PROBE budget run answer (must never be reached)." },
      ],
      coordinator: [
        // Seed runs: their replies become group messages, so the probe run carries a sizeable
        // group reference like a real group does.
        ...[1, 2, 3].map((n) => ({ text: seedReply(n) })),
        // Probe run. The delay on the third request leaves time for a member message to arrive
        // mid-run (an appended reference update); the plan update on the second request
        // is a mid-run state change (an appended state #2).
        { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
        { toolCalls: [plan(0, 0)] },
        { ...read("notes-a.md"), delayMs: 600 },
        read("notes-b.md"),
        { text: "CACHE-PROBE group answer." },
        // The run the mid-run message itself starts.
        { text: "CACHE-PROBE group answer 2." },
      ],
    },
  };
}

/** Requests of the coordinator's probe run; the next one belongs to the run the message starts. */
const GROUP_RUN_REQUESTS = 5;

/** Text of the first seed member message: it reaches the coordinator through saved references. */
const PURGE_MARKER = "CACHE-PROBE seed 1:";

/**
 * Saved group references go when the content stops being available. The topic the probe
 * ran in is archived (after switching to a fresh one); afterwards no saved reference entry in any
 * session file may hold the seed text, placeholders keep the entries' places, and a run in the
 * restored topic still works and opens with a fresh full reference.
 */
async function purgeStep(f: Fixture, captured: Captured[], variant: string) {
  const entries = async () => (await sessionEntries(f.root)) as Record<string, unknown>[];
  const saved = (list: Record<string, unknown>[], type: string) =>
    list.filter((entry) => entry.type === "custom_message" && entry.customType === type);
  const holding = (list: Record<string, unknown>[]) =>
    saved(list, "pibot_reference").filter((entry) => JSON.stringify(entry).includes(PURGE_MARKER));
  const before = holding(await entries()).length;
  assert(before > 0, "a saved reference holds the seed message before the purge");
  const topic = (await f.client.call("groups.get", { groupId: f.group.id })).conversationId;
  assert(topic, "the group has a current topic");
  await f.client.call("groups.topics.create", { groupId: f.group.id });
  await f.client.call("groups.topics.archive", { groupId: f.group.id, topicId: topic });
  const after = await entries();
  assert.equal(holding(after).length, 0, "no saved reference holds the seed text after archiving");
  const placeholders = saved(after, "pibot_reference_removed").length;
  assert(placeholders >= before, "purged entries keep their places as placeholders");
  const audit = await f.client.call("audit.list", { kind: "group.reference.purged" });
  assert(
    audit.some((row) => row.detail.reason === "topic_archived" && (row.detail.entryCount ?? 0) > 0),
    "the purge left an audit row with counts",
  );
  // The run's own starting messages are pi user messages, kept as they are (not purged).
  const userCopies = after.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message as { role?: string } | undefined)?.role === "user" &&
      JSON.stringify(entry).includes(PURGE_MARKER),
  ).length;
  await f.client.call("groups.topics.restore", { groupId: f.group.id, topicId: topic });
  await f.client.call("groups.topics.switch", { groupId: f.group.id, topicId: topic });
  const sent = captured.length;
  await f.client.call("chat.send", { groupId: f.group.id, text: "CACHE-PROBE after the purge" });
  await groupIdle(f);
  const runs = await f.client.call("chat.runs", { groupId: f.group.id });
  assert.equal(runs[0]?.status, "done", "the next run in the restored topic finishes");
  const request = captured
    .slice(sent)
    .find((entry) => entry.variant === variant && entry.route === "coordinator");
  assert(request, "the run after the purge reached the model");
  const body = JSON.stringify(request.body);
  assert(body.includes("Group reference removed"), "the placeholder stands where the entry was");
  assert(body.includes("captured when this run started"), "the run opens with a full reference");
  return `saved references holding the seed text ${before} -> 0, placeholders ${placeholders}, run's own user messages still holding it ${userCopies} (not purged), next run ${runs[0]?.status} with a fresh full reference`;
}

/** Chat Completions in render order: system message, tool declarations, conversation. */
function completionsSections(body: Json): Section[] {
  const [first, ...rest] = body.messages as Json[];
  return [
    { label: "system", type: "system", text: JSON.stringify(first), eligible: false },
    { label: "tools", type: "tools", text: JSON.stringify(body.tools ?? []), eligible: false },
    ...rest.map((item, i) => ({
      label: `item[${i}]`,
      type: String(item.role),
      text: JSON.stringify(item),
      eligible: false,
    })),
  ];
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Owner rule 2: limits are enforced by the program, the prompt only informs. The run's
 * tool-call limit is set to two and the model keeps calling tools; BudgetService must refuse the
 * third call, stop the run and record the exhaustion on the receipt. The state message never
 * shows budget numbers, so nothing here depends on what the model reads.
 */
async function budgetRun(f: Fixture, conversationId: string) {
  const scope = { botId: f.researcher.id, conversationId };
  const settings = await f.client.call("execution.get", scope);
  await f.client.call("execution.set", {
    ...scope,
    expectedVersion: settings.version,
    mode: settings.mode,
    limits: { ...settings.limits, toolCalls: BUDGET_LIMIT },
  });
  const reply = await dmDone(f, "CACHE-PROBE budget: keep reading until told to stop.");
  assert(reply?.runId, "budget run has a run id");
  assert.equal(reply.status, "error", "budget run is stopped, not finished by the model");
  assert.equal(reply.errorCode, "budget_exhausted");
  const tools = (reply.tools ?? []).map((tool) => tool.status);
  // Exactly the allowed calls ran; the next one was refused by code; none after it was tried.
  assert.equal(tools.filter((status) => status === "done").length, BUDGET_LIMIT);
  assert.equal(tools.length, BUDGET_LIMIT + 1, `tool records: ${tools.join(",")}`);
  const receipt = await until(
    "budget receipt",
    async () => {
      await wait(100);
      return f.client.call("runs.receipt", { runId: reply.runId as string });
    },
    (value) => value.outcome !== "running",
  );
  assert.equal(receipt.reasonCode, "budget_exhausted");
  assert.equal(receipt.cost?.exhaustedReason, "tool_calls");
  // Restore the default so a later run of the topic is not limited.
  const now = await f.client.call("execution.get", scope);
  await f.client.call("execution.set", {
    ...scope,
    expectedVersion: now.version,
    mode: now.mode,
    limits: settings.limits,
  });
  return { receipt, tools };
}

export async function runCacheProbe(root: string, verbose = false) {
  const captured: Captured[] = [];
  const budget: string[] = [];
  const purge: string[] = [];
  for (const variant of variants) {
    let phase = "setup";
    let groupRequests = 0;
    let midRun: Promise<unknown> | undefined;
    const f = await fixture(
      scenario(),
      root,
      {},
      {},
      {
        api: variant.api,
        ...(variant.compat ? { compat: variant.compat } : {}),
        onRequest(body, route) {
          captured.push({ variant: variant.name, route, phase, body: structuredClone(body) });
          if (route !== "coordinator" || !phase.startsWith("group-run")) return;
          groupRequests++;
          // Third request of the probe run: a member writes while the run is still working.
          if (groupRequests === 3)
            midRun = f.client.call("chat.send", {
              groupId: f.group.id,
              text: `CACHE-PROBE 补充一句：${"新消息 mid-run note. ".repeat(20)}`,
            });
          if (groupRequests === GROUP_RUN_REQUESTS) phase = "group-run-2";
        },
      },
    );
    try {
      await writeFile(join(f.root, "notes-a.md"), pageA);
      await writeFile(join(f.root, "notes-b.md"), pageB);
      phase = "dm-run-1";
      const first = await dmDone(f, "CACHE-PROBE please read the notes and summarize them.");
      assert(first?.status === "done", "DM run 1 finishes");
      phase = "dm-run-2";
      assert.equal((await dmDone(f, "CACHE-PROBE read A again."))?.status, "done");
      phase = "dm-run-3";
      assert.equal((await dmDone(f, "CACHE-PROBE thanks, one more line?"))?.status, "done");
      phase = "dm-budget";
      const { receipt, tools } = await budgetRun(f, first.conversationId);
      const calls = captured.filter(
        (entry) =>
          entry.variant === variant.name && entry.route === "researcher" && entry.phase === phase,
      ).length;
      // The model would have asked for BUDGET_CALLS tools in as many requests.
      assert(calls < BUDGET_CALLS, "the program stops the run long before the model does");
      budget.push(
        `${variant.name}: model scripted ${BUDGET_CALLS} tool calls, limit ${BUDGET_LIMIT}: tools ${tools.join(",")}; ${calls} model requests; run ${receipt.outcome} (${receipt.reasonCode}, exhaustedReason ${receipt.cost?.exhaustedReason})`,
      );
      for (const n of [1, 2, 3]) {
        phase = `group-seed-${n}`;
        await f.client.call("chat.send", {
          groupId: f.group.id,
          text: `CACHE-PROBE seed ${n}: ${"Synthetic member message about the shared notes. ".repeat(12)}`,
        });
        await groupIdle(f);
      }
      phase = "group-run";
      await f.client.call("chat.send", { groupId: f.group.id, text: "CACHE-PROBE 读一下笔记" });
      await until(
        "mid-run group message",
        async () => midRun !== undefined,
        (sent) => sent,
      );
      await midRun;
      await groupIdle(f);
      assert.equal(f.blocked(), 0);
      phase = "group-purge";
      purge.push(`${variant.name}: ${await purgeStep(f, captured, variant.name)}`);
    } finally {
      await f.cleanup();
    }
  }
  const lines = [
    "== Program-enforced limits (owner rule 2)",
    ...budget.map((line) => `   ${line}`),
    "== Purge on archive (save, but purge on delete)",
    ...purge.map((line) => `   ${line}`),
  ];
  for (const variant of variants) {
    const responses = variant.api === "openai-responses";
    lines.push(`\n== ${variant.name}`);
    for (const route of ["researcher", "coordinator"]) {
      const list = captured.filter(
        (entry) =>
          entry.variant === variant.name &&
          entry.route === route &&
          entry.phase !== "setup" &&
          entry.phase !== "dm-budget" &&
          entry.phase !== "group-purge",
      );
      lines.push(`-- ${route}: ${list.length} requests`);
      if (!responses) {
        const after = list.map((entry) => completionsSections(entry.body));
        for (let i = 1; i < list.length; i++) {
          const diff = firstDifference(after[i - 1] ?? [], after[i] ?? []);
          const same = list[i - 1]?.phase === list[i]?.phase ? "same run" : "new run ";
          lines.push(
            `   ${String(i).padStart(2)} ${String(list[i]?.phase).padEnd(12)} ${same} ${pct(diff.prefix).padStart(7)}` +
              (verbose || diff.prefix < 0.97 ? `\n      ${diff.at}` : ""),
          );
        }
        continue;
      }
      lines.push(...(await responsesReport(list, verbose)));
    }
  }
  return lines.join("\n");
}

/**
 * Responses rows: layout, the cache diagnostic's own view (does the request extend the previous
 * one item for item; where the states sit; what trails) and simulated uncached characters for the
 * three layouts under both cache rules. Asserts owner rule 3: within a run every request extends
 * the previous one, so no item already sent was edited.
 */
async function responsesReport(list: Captured[], verbose: boolean) {
  const layouts = {
    pre: list.map((entry) => responsesSections(singleMessageLayout(entry.body))),
    trailing: list.map((entry) => responsesSections(trailingStateLayout(entry.body))),
    append: list.map((entry) => responsesSections(entry.body)),
  };
  const sims = Object.fromEntries(
    (["guide", "trailing"] as CacheRule[]).map((rule) => [
      rule,
      Object.fromEntries(
        Object.entries(layouts).map(([name, requests]) => [
          name,
          simulateImplicitCache(requests, rule),
        ]),
      ),
    ]),
  ) as Record<CacheRule, Record<keyof typeof layouts, { cached: number; total: number }[]>>;
  const uncached = (rule: CacheRule, name: keyof typeof layouts, i: number) => {
    const row = sims[rule][name][i];
    return row ? row.total - row.cached : 0;
  };
  const diagnostics = new CacheDiagnostics();
  const broken: string[] = [];
  const opening: string[] = [];
  const lines = [
    "   #  phase        run   ext   hdr   tail                  uncached chars: Codex rule trailing-state -> append-only | guide rule trailing-state -> append-only   layout",
  ];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as Captured;
    diagnostics.request(entry.body, "openai-responses", "sse");
    const line = await diagnostics.settle(undefined, "openai-responses", undefined);
    if (!i) continue;
    // A phase can hold several runs (the mid-run message starts more group work).
    const previous = list[i - 1] as Captured;
    const same = previous.phase === entry.phase && turns(previous.body) === turns(entry.body);
    if (same && line?.extendsPrevious !== true)
      broken.push(`${entry.phase} request ${i} (first change ${line?.firstChange})`);
    // A new run continues the previous run's last request item for item (states,
    // references and tool loads of earlier runs are in place), so its first request reads the
    // whole previous request from the cache.
    if (!same) {
      opening.push(`${entry.phase}#${i} ${uncached("trailing", "append", i)}`);
      // `--baseline` reports an older build (no persisted states) without failing on this.
      if (line?.extendsPrevious !== true && !process.argv.includes("--baseline"))
        broken.push(`${entry.phase} first request ${i} (first change ${line?.firstChange})`);
    }
    const diff = firstDifference(layouts.append[i - 1] ?? [], layouts.append[i] ?? []);
    lines.push(
      `   ${String(i).padStart(2)} ${entry.phase.padEnd(12)} ${same ? "same" : "new "}  ${String(line?.extendsPrevious ?? "-").padEnd(5)} ${String(line?.headerChanged ?? "-").padEnd(5)} ${(line?.tail.at(-1) ?? "").padEnd(21)} ${String(uncached("trailing", "trailing", i)).padStart(17)} -> ${String(uncached("trailing", "append", i)).padStart(6)} | ${String(uncached("guide", "trailing", i)).padStart(17)} -> ${String(uncached("guide", "append", i)).padStart(6)}   ${layout(entry.body)}` +
        (verbose || (!same && diff.prefix < 0.97) ? `\n      ${diff.at}` : ""),
    );
  }
  // Each layout against its own total: they differ by a few state items.
  const share = (rule: CacheRule, name: keyof typeof layouts) => {
    const rows = sims[rule][name];
    const total = rows.reduce((acc, row) => acc + row.total, 0);
    const missed = rows.reduce((acc, row) => acc + row.total - row.cached, 0);
    return `${pct(total ? missed / total : 0)} (${missed}/${total})`;
  };
  for (const rule of ["trailing", "guide"] as CacheRule[])
    lines.push(
      `   ${rule === "trailing" ? "Codex (observed) rule" : "documented GPT-5.6+ rule"}: uncached chars single-message ${share(rule, "pre")}, trailing-state ${share(rule, "trailing")}, append-only ${share(rule, "append")}`,
    );
  lines.push(
    `   first request of each new run, uncached chars (Codex rule): ${opening.join(", ")}`,
  );
  if (broken.length) console.log(lines.join("\n"));
  assert.deepEqual(broken, [], "every request extends the previous one item for item");
  return lines;
}
