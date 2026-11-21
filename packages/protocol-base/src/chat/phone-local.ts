/**
 * A reply the phone's own model wrote while the computer was unreachable,
 * imported into the Bot's topic. The import marks it in `usage.source`; interfaces show it as
 * "answered on the phone" next to the computer's own replies in the same topic.
 */
export function answeredOnPhone(usage: unknown): boolean {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const source = (usage as { source?: unknown }).source;
  return (
    !!source &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    (source as { kind?: unknown }).kind === "phone_local"
  );
}
