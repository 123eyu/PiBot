// Sign in with ChatGPT ships complete. It was closed until the
// open-source release because OpenAI admits open-source integrations and approved clients only;
// the owner reviewed that and opened it for v0.0.2 (2026-11-13 evening). This stays a release
// decision in code: no environment variable, setting or checkbox can change it.
export const chatGPTSubscriptionAccess: { readonly available: boolean } = Object.freeze({
  available: true,
});

export type ChatGPTUnavailableReason = "openai_approval_required";

export function chatGPTSignInAvailability(): {
  available: boolean;
  unavailableReason?: ChatGPTUnavailableReason;
} {
  return chatGPTSubscriptionAccess.available
    ? { available: true }
    : { available: false, unavailableReason: "openai_approval_required" };
}
