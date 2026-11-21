/** Keep both the user's current request and the hand-off, never appended historical results. */
export function memoryRecallQuery(request: string, handoff: string | readonly string[] = []) {
  const inputs = [
    ...new Set([request, ...(typeof handoff === "string" ? [handoff] : handoff)].filter(Boolean)),
  ];
  // Every pending input gets space even when the original task fills the query budget.
  const limit = Math.min(4096, Math.floor((8192 - inputs.length) / Math.max(1, inputs.length)));
  return inputs.map((text) => text.slice(0, limit)).join("\n");
}
