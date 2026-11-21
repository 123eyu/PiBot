import type { Decision, PolicyRequest } from "./types.ts";

// Keep the port explicit; it never sends approval facts to an external reviewer.
export const jev = Object.freeze({
  review(_request: PolicyRequest): Decision {
    return "ask";
  },
});
