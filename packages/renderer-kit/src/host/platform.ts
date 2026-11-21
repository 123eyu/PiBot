/**
 * The desktop's OS (`process.platform` values), read from the preload bridge. Capability UIs use
 * this instead of `window.pibot`, whose full type belongs to the desktop app.
 */
export function hostPlatform(): string | undefined {
  return (globalThis as { pibot?: { platform?: string } }).pibot?.platform;
}
