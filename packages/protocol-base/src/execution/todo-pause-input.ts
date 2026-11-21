const pauseReasons = new Set([
  "blocked",
  "review",
  "checkpoint",
  "waiting_tasks",
  "awaiting_reply",
]);
const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim());

function emptyFields(value: unknown, names: readonly string[]) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => names.includes(key) && blank(item))
  );
}

function emptyQuestion(value: unknown) {
  if (blank(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const question = value as Record<string, unknown>;
  if (Object.keys(question).some((key) => !["prompt", "options", "recommendedId"].includes(key)))
    return false;
  return (
    blank(question.prompt) &&
    blank(question.recommendedId) &&
    (blank(question.options) ||
      (Array.isArray(question.options) &&
        question.options.length <= 4 &&
        question.options.every((option) => emptyFields(option, ["id", "label", "description"]))))
  );
}

/** Empty optional placeholders express no decision; any actual question must keep failing closed. */
export function normalizeTodoPauseInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const pause = input as Record<string, unknown>;
  if (
    typeof pause.reason !== "string" ||
    !pauseReasons.has(pause.reason) ||
    typeof pause.summary !== "string" ||
    !pause.summary.trim() ||
    pause.summary.trim().length > 500 ||
    !Object.hasOwn(pause, "question") ||
    !emptyQuestion(pause.question)
  )
    return input;
  const { question: _question, ...normalized } = pause;
  return normalized;
}
