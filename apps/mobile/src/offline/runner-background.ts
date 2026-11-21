import { decidePortable } from "@pibot/policy/portable";
import {
  type OfflineRunnerReceipt,
  RunnerBackgroundPageSchema,
  RunnerBackgroundSnapshotSchema,
} from "@pibot/protocol";
import { z } from "zod";
import type { PhoneRunnerClient } from "./runner-client.ts";
import type { OfflineRunnerDeps } from "./runner-tools.ts";
import type { ToolOutcome } from "./tools.ts";

const backgroundSchema = z.strictObject({
  action: z.enum(["list", "output", "wait", "stop"]),
  id: z.string().uuid().optional(),
  after: z.string().uuid().optional(),
  maxChars: z.number().int().min(200).max(20000).optional(),
  seconds: z.number().int().min(1).max(120).optional(),
  until: z.enum(["output", "end"]).optional(),
});

export async function runOfflineBackground(
  client: PhoneRunnerClient,
  deps: OfflineRunnerDeps,
  receipt: OfflineRunnerReceipt,
  raw: unknown,
  signal: AbortSignal,
  save: () => Promise<void>,
  onDispatch: () => void,
): Promise<ToolOutcome> {
  const name = "background_command";
  const args = backgroundSchema.parse(raw);
  if (decidePortable({ category: "background" }).decision !== "allow")
    throw new Error("policy_denied");
  if (args.action === "list") {
    const value = RunnerBackgroundPageSchema.parse(
      await client.pull(
        await client.call(
          "runner.background.list",
          { maxChars: args.maxChars ?? 2000, after: args.after },
          signal,
        ),
        signal,
      ),
    );
    receipt.summary = JSON.stringify({
      jobs: value.items.map((job) => ({ id: job.id, running: job.running })),
      nextCursor: value.nextCursor,
    });
    receipt.outcome = "done";
    receipt.reason = "own_background_commands";
    await save();
    return {
      text: deps.redact(receipt.summary),
      isError: false,
      record: { name, outcome: "allowed" },
    };
  }
  if (!args.id) throw new Error("invalid_arguments");
  const key = { idempotencyKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
  if (args.action === "stop") {
    receipt.idempotencyKey = key.idempotencyKey;
    receipt.outcome = "unknown";
    await save();
    onDispatch();
  }
  let descriptor =
    args.action === "stop"
      ? await client.call("runner.background.stop", { ...key, jobId: args.id }, signal)
      : await client.call(
          "runner.background.inspect",
          { jobId: args.id, maxChars: args.maxChars ?? 2000 },
          signal,
        );
  if (!descriptor) throw new Error("background_unavailable");
  let value = RunnerBackgroundSnapshotSchema.parse(await client.pull(descriptor, signal));
  const deadline = Date.now() + Math.min(120, args.seconds ?? 10) * 1000;
  const initial = value.output;
  while (
    args.action === "wait" &&
    value.running &&
    Date.now() < deadline &&
    (args.until === "end" || value.output === initial)
  ) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    signal.throwIfAborted();
    if (!deps.canStart()) break;
    descriptor = await client.call(
      "runner.background.inspect",
      { jobId: args.id, maxChars: args.maxChars ?? 2000 },
      signal,
    );
    if (!descriptor) throw new Error("background_unavailable");
    value = RunnerBackgroundSnapshotSchema.parse(await client.pull(descriptor, signal));
    deps.output(deps.redact(value.output));
  }
  const reply = JSON.stringify({
    id: value.id,
    running: value.running,
    output: value.output,
    ended: value.ended,
  });
  receipt.summary = JSON.stringify({
    id: value.id,
    running: value.running,
    ended: value.ended,
  });
  receipt.outcome = "done";
  receipt.reason = "own_background_commands";
  await save();
  return {
    text: deps.redact(reply),
    isError: false,
    record: { name, outcome: "allowed" },
  };
}
