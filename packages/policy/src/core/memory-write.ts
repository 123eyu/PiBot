import { createPolicyTrace } from "./explain.ts";
import type { PolicyResult } from "./types.ts";

export interface MemoryWriteFacts {
  text?: string;
  afterUntrusted?: boolean;
  scope?: "user" | "bot" | "group" | "project";
}

// Bounded deterministic heuristics request consent; they do not classify or retain medical data.
const sensitive = [
  /(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{12,}/,
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i,
  /(?:password|passwd|api[ _-]?key|access[ _-]?token|secret|密码|口令|密钥|令牌)\s*(?:is\b|是|为|[:=：])\s*\S+/i,
  /\b\d{17}[\dXx]\b|\b\d{3}-\d{2}-\d{4}\b/,
  /(?:身份证|证件号|护照号|passport(?:\s+(?:number|no\.?))?|social security)\s*(?:是|为|[:=：#])?\s*[A-Za-z0-9-]{5,}/i,
  /(?:诊断|病史|病历|患有|过敏|用药|服药|抑郁症|糖尿病|高血压|怀孕|癌症|HIV|medical history|diagnos(?:is|ed)|allerg(?:y|ic)|medication|diabet(?:es|ic)|pregnan(?:t|cy)|cancer|blood pressure)/i,
];

/** The same decision guards initial dispatch and a pending proposal's automatic acceptance. */
export function memoryWritePolicy(facts: MemoryWriteFacts): PolicyResult {
  const reason = facts.afterUntrusted
    ? "memory_after_untrusted"
    : sensitive.some((pattern) => pattern.test(facts.text ?? ""))
      ? "memory_sensitive"
      : "bot_owned_memory";
  return createPolicyTrace().result(
    {
      decision: reason === "bot_owned_memory" ? "allow" : "ask",
      reason,
      risk: "normal",
      facts: facts.scope === "user" ? [{ kind: "warning", value: "memory_scope_user" }] : [],
      canRemember: false,
    },
    "boundary",
  );
}
