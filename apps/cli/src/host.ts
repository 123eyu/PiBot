import type { BrainHost } from "@pibot/brain-app";

/**
 * Host ports for the headless CLI. There is no Electron, no keychain and no user to answer a file
 * dialog, so every optional port that needs one stays absent and the brain refuses those features
 * with a defined error instead of pretending to support them.
 *
 * The cipher is a plain passthrough: this entry point is for development and scripted checks, and
 * `--data` points at a throwaway directory. It must not be used with real credentials.
 */
export function cliHost(options?: { pickFolder?: BrainHost["pickFolder"] }): BrainHost {
  return {
    secrets: {
      isAvailable: async () => true,
      encrypt: async (plain) => new TextEncoder().encode(plain),
      decrypt: async (cipher) => new TextDecoder().decode(cipher),
    },
    env: { detect: async () => [], read: async () => undefined },
    ...(options?.pickFolder ? { pickFolder: options.pickFolder } : {}),
  };
}
