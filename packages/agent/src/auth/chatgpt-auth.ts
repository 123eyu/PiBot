import type { OAuthAuth } from "@earendil-works/pi-ai";

/** SDK's caller cancellation races its login; retain the underlying listener's real lifetime. */
export function trackedChatGPTAuth(auth: OAuthAuth) {
  const pending = new Set<Promise<unknown>>();
  return {
    auth: {
      ...auth,
      login(interaction, options) {
        const work = Promise.resolve().then(() => auth.login(interaction, options));
        pending.add(work);
        const release = () => pending.delete(work);
        void work.then(release, release);
        return work;
      },
    } satisfies OAuthAuth,
    async settled() {
      await Promise.allSettled([...pending]);
    },
  };
}
