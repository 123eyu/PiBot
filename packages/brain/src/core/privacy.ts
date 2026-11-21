import {
  createRedactor,
  type NamedRedactor,
  type Redactor,
  withNamedRedaction,
} from "@pibot/secrets";

export type BrainRedactor = NamedRedactor;

export function createBrainRedactor(): BrainRedactor {
  return withNamedRedaction(createRedactor());
}

export function redactValue(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactor));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, redactor)]),
    );
  return value;
}
