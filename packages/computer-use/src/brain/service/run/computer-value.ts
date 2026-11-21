/** Redact before shortening: a truncation must not cut a known credential before matching it. */
export function focusValueText(
  value: string | undefined,
  redactor: { redact(text: string): string },
) {
  if (value === undefined) return "";
  const safe = redactor.redact(value);
  return `\nUntrusted focused value / 不可信焦点值: ${JSON.stringify(safe.length > 500 ? `${safe.slice(0, 499)}…` : safe)}`;
}
