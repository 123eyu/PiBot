import { describe, expect, it } from "vitest";
import { createBrainRedactor } from "./privacy.ts";

describe("stream credential redaction", () => {
  it.each(["abcabcabc", "long-secret", "Bearer company-password"])(
    "masks %s at every delta split",
    (secret) => {
      for (let index = 1; index < secret.length; index++) {
        const redactor = createBrainRedactor();
        redactor.add(secret);
        const stream = redactor.stream();
        const text =
          stream.push(secret.slice(0, index)) + stream.push(secret.slice(index)) + stream.finish();
        expect(text).toBe("[REDACTED]");
      }
    },
  );
  it("preserves ordinary text and releases incomplete prefixes on completion", () => {
    const redactor = createBrainRedactor();
    redactor.add("secret-password");
    const stream = redactor.stream();
    expect(stream.push("a se")).toBe("a ");
    expect(stream.push("aside")).toBe("seaside");
    expect(stream.push(" sec")).toBe(" ");
    expect(stream.finish()).toBe("sec");
  });
});
