import { SafeSecretSchema } from "@pibot/protocol-base";
import { describe, expect, it } from "vitest";
import { assertSafeSecretValue, createRedactor, keyHint } from "../src/index.ts";

const invalid = [
  "",
  " ",
  "\t",
  " key",
  "key ",
  "\tkey",
  "key\t",
  "\u00a0key",
  "key\u3000",
  "\ufeffkey",
  "key\n",
  "key\r",
  "ke\ny",
  "ke\ry",
  "ke\r\ny",
  "!command",
  "!",
  " !command",
];
const valid = ["fake-key", "a", "key with space", "ke\ty", "ke!y", "密钥", "a.b+$()[]\\"];

describe("assertSafeSecretValue", () => {
  it.each(invalid)("rejects unsafe value %j with the protocol rules", (value) => {
    expect(SafeSecretSchema.safeParse(value).success).toBe(false);
    expect(() => assertSafeSecretValue(value)).toThrow("Unsafe secret value");
  });

  it.each(valid)("accepts safe value %j with the protocol rules", (value) => {
    expect(SafeSecretSchema.safeParse(value).success).toBe(true);
    expect(() => assertSafeSecretValue(value)).not.toThrow();
  });

  it("does not include rejected plaintext in the error", () => {
    expect(() => assertSafeSecretValue("!private-credential")).toThrow(/^Unsafe secret value$/);
  });
});

describe("createRedactor", () => {
  it("replaces all registered occurrences, including embedded values and regex metacharacters", () => {
    const redactor = createRedactor();
    const secret = "a.b+$()[]\\";
    redactor.add(secret);
    redactor.add(secret);
    expect(redactor.redact(`prefix${secret}suffix ${secret}`)).toBe(
      "prefix[REDACTED]suffix [REDACTED]",
    );
    expect(redactor.redact("aXb is ordinary text")).toBe("aXb is ordinary text");
  });

  it("masks longer registered values first regardless of registration order", () => {
    for (const values of [
      ["token-secret", "token-secret-long"],
      ["token-secret-long", "token-secret"],
    ]) {
      const redactor = createRedactor();
      for (const value of values) redactor.add(value);
      expect(redactor.redact("token-secret-long token-secret")).toBe("[REDACTED] [REDACTED]");
    }
  });

  it("combines overlaps between registered values and key format matches", () => {
    const key = `sk-${"a".repeat(25)}`;
    const redactor = createRedactor();
    redactor.add(`${key}/private`);
    redactor.add("prefix:sk-aaaaa");
    expect(redactor.redact(`${key}/private prefix:${key}`)).toBe("[REDACTED] [REDACTED]");
  });

  it("masks intersecting and self-overlapping registered values in full", () => {
    const redactor = createRedactor();
    redactor.add("abcdefgh");
    redactor.add("fghijklm");
    redactor.add("ababababa");
    expect(redactor.redact("abcdefghijklm abababababa")).toBe("[REDACTED] [REDACTED]");
  });

  it.each([
    `sk-${"A1".repeat(20)}`,
    `sk-proj-${"aB_1-".repeat(10)}`,
    `sk-ant-api03-${"aB_1-".repeat(10)}`,
    `xai-${"aB_1-".repeat(10)}`,
    `AIza${"aB_1-".repeat(7)}`,
    `ghp_${"A1".repeat(18)}`,
    `gho_${"A1".repeat(18)}`,
    `github_pat_${"aB_1".repeat(20)}`,
    `gsk_${"A1".repeat(26)}`,
    `hf_${"A1".repeat(17)}`,
  ])("masks key format %s without prior registration", (key) => {
    const redactor = createRedactor();
    const input = `Bearer ${key}, {"apiKey":"${key}"}`;
    expect(redactor.redact(input)).toBe('Bearer [REDACTED], {"apiKey":"[REDACTED]"}');
    expect(redactor.redact(input)).toBe(redactor.redact(input));
  });

  it("does not mask ordinary text, abbreviated examples, or embedded prefix lookalikes", () => {
    const text = `ask-me sk-short sk-ant-example xai-news AIza ghp_docs gsk_notes flask-${"a".repeat(25)} my_gsk_${"a".repeat(25)} 中文 English 1234`;
    expect(createRedactor().redact(text)).toBe(text);
  });

  it.each(invalid)("rejects unsafe registration %j", (value) => {
    const redactor = createRedactor();
    expect(() => redactor.add(value)).toThrow("Unsafe secret value");
    expect(redactor.redact("ordinary text")).toBe("ordinary text");
  });

  it("keeps separate redactor instances isolated and supports registrations after use", () => {
    const first = createRedactor();
    const second = createRedactor();
    expect(first.redact("private-key")).toBe("private-key");
    first.add("private-key");
    expect(first.redact("private-key")).toBe("[REDACTED]");
    expect(second.redact("private-key")).toBe("private-key");
  });
});

describe("keyHint", () => {
  it.each([
    ["abcdefgh", "efgh"],
    ["abcd", undefined],
    ["abc", undefined],
    ["a", undefined],
    ["一二三四五", undefined],
  ])("returns only the final four characters of %s", (secret, expected) => {
    expect(keyHint(secret)).toBe(expected);
  });

  it.each(invalid)("rejects unsafe hint input %j", (value) => {
    expect(() => keyHint(value)).toThrow("Unsafe secret value");
  });
});
