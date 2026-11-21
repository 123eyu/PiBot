import type { TaskSummary } from "@pibot/protocol-base";
import { continuationPromptsPrompts } from "./prompts/continuation-prompts.ts";

/**
 * Prompt templates for automatic continuations. Text lives here so every call site sends the same
 * wording; changing it changes what models see, so keep edits deliberate.
 */

export function bounded(text: string, bytes: number) {
  const value = Buffer.from(text);
  return new TextDecoder().decode(value.subarray(0, bytes), { stream: value.length > bytes });
}

export function resultPrompt(items: TaskSummary[], resume = false) {
  const rowBytes = Math.floor(60_000 / items.length);
  const results = items.map((task) => {
    const original = task.result ?? "";
    const value = {
      taskId: task.id,
      runId: task.runId,
      title: bounded(task.title.replace(/[\p{Cc}\p{Cf}]/gu, " "), 160),
      status: task.status,
      result: bounded(original, Math.max(100, rowBytes - 400)),
      resultTruncated: task.resultTruncated,
      needsVerification: task.needsVerification,
    };
    // Bound the encoded JSON too: quotes, slashes and controls can expand far beyond UTF-8 bytes.
    while (Buffer.byteLength(JSON.stringify(value)) > rowBytes && value.result.length)
      value.result = bounded(value.result, Math.floor(Buffer.byteLength(value.result) / 2));
    value.resultTruncated ||= value.result !== original;
    return value;
  });
  const instructions = resume
    ? [
        continuationPromptsPrompts.resultPrompt.resume.item1,
        continuationPromptsPrompts.resultPrompt.resume.item2,
      ]
    : [
        continuationPromptsPrompts.resultPrompt.settled.item1,
        continuationPromptsPrompts.resultPrompt.settled.item2,
        continuationPromptsPrompts.resultPrompt.settled.item3,
        continuationPromptsPrompts.resultPrompt.settled.item4,
      ];
  return [
    ...instructions,
    continuationPromptsPrompts.resultPrompt.item2,
    continuationPromptsPrompts.resultPrompt.item3,
    JSON.stringify(results),
  ].join("\n\n");
}

/** Explicit user retry of one assigned group task; the original tool-bearing request is not replayed. */
export function groupTaskRetryPrompt() {
  return continuationPromptsPrompts.groupTaskRetryPrompt;
}

/** Explicit user retry with a model choice; `goal` is only added when no session was established. */
export function modelRetryPrompt(goal = "") {
  return continuationPromptsPrompts.modelRetryPrompt + goal;
}

/**
 * The user's 「继续」 on a run a restart interrupted. The facts (which calls have an unknown
 * outcome) ride in the trusted runtime state (`resumeNote`); `goal` only when the interrupted run
 * never reached the model, so its request is not in the session yet.
 */
export function interruptedResumePrompt(goal = "") {
  return continuationPromptsPrompts.interruptedResumePrompt + goal;
}

/** The user raised a workflow's cost cap after it stopped there. */
export function budgetRaisedResumePrompt(goal = "") {
  return continuationPromptsPrompts.budgetRaisedResumePrompt + goal;
}

/** The saved user goal as reference material, passed already redacted: never tools to replay. */
export function savedGoalPrompt(redacted: string) {
  return `\n尚未建立模型会话。以下是该话题已保存的原目标，仅作为目标资料；先核对当前成果再开始，不据此重放工具。 / No model session was established. Saved user goal for context; verify existing outcomes before acting:\n${redacted}`;
}

/** A promise alone is not progress or authority; the reminder stays in the owning run. */
export function promiseFollowThroughPrompt() {
  return [
    continuationPromptsPrompts.promiseFollowThroughPrompt.item1,
    continuationPromptsPrompts.promiseFollowThroughPrompt.item2,
  ].join("\n");
}

/**
 * Sent after a response hit the model's single-response output cap. Splitting large output is the
 * only way a capped model finishes: the next response has the same cap, so repeating the same
 * shape would run into it again.
 */
export function outputLimitContinuation(repeatedThinking: boolean) {
  const repeat = repeatedThinking
    ? [
        continuationPromptsPrompts.outputLimitContinuation.repeatedThinking.item1,
        continuationPromptsPrompts.outputLimitContinuation.repeatedThinking.item2,
      ]
    : [];
  return [
    ...repeat,
    continuationPromptsPrompts.outputLimitContinuation.item2,
    continuationPromptsPrompts.outputLimitContinuation.item3,
  ].join("\n");
}

/**
 * Fixed wording (prompt cache) after the model connection dropped mid-reply. The text the
 * user already saw is the previous assistant message; nothing it was about to call ran.
 */
export function connectionContinuation() {
  return [
    continuationPromptsPrompts.connectionContinuation.item1,
    continuationPromptsPrompts.connectionContinuation.item2,
  ].join("\n");
}

/**
 * Fixed wording for the one reminder after a document-shaped reply that never wrote a
 * file. Fixed text (no paths, counts or run ids) keeps it out of the cache-sensitive prefix and
 * makes the audit entry and the model input identical on every run.
 */
export function deliveryFileReminder() {
  return [
    continuationPromptsPrompts.deliveryFileReminder.item1,
    continuationPromptsPrompts.deliveryFileReminder.item2,
  ].join("\n");
}

/** One fixed correction when prose claims a file was sent but no send_file receipt exists. */
export function deliveryAttachmentReminder() {
  return [
    continuationPromptsPrompts.deliveryAttachmentReminder.item1,
    continuationPromptsPrompts.deliveryAttachmentReminder.item2,
  ].join("\n");
}

/**
 * One fixed correction when a completed turn shows the user nothing at all: no text and no tool
 * call (a translator judged a pasted report "not a request" and stopped silently, 2026-11-18).
 */
export function emptyReplyReminder() {
  return [
    continuationPromptsPrompts.emptyReplyReminder.item1,
    continuationPromptsPrompts.emptyReplyReminder.item2,
  ].join("\n");
}

/** Nudge for a run that updated its own TODO and still has unfinished items. */
export function todoFollowThroughPrompt(
  step?: { index: number; title: string },
  unloaded: readonly string[] = [],
) {
  return [
    continuationPromptsPrompts.todoFollowThroughPrompt.item1,
    continuationPromptsPrompts.todoFollowThroughPrompt.item2,
    continuationPromptsPrompts.todoFollowThroughPrompt.item3,
    continuationPromptsPrompts.todoFollowThroughPrompt.item4({
      value: unloaded.join(", ") || "none / 无",
    }),
    ...(step
      ? [
          continuationPromptsPrompts.todoFollowThroughPrompt.currentStep({
            step: JSON.stringify(step),
          }),
        ]
      : []),
  ].join("\n");
}

/** The user turned on automatic review; sent once after a turn that changed files. */
export function autoReviewPrompt() {
  return continuationPromptsPrompts.autoReviewPrompt;
}
