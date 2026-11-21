/**
 * pi-coding-agent is the single largest module graph on the brain's startup path
 * (≈1 s idle, 3–5 s under load), yet nothing before the first model operation needs it. It is
 * loaded on first use, or by the background preload after the brain reports ready. The patched
 * `./sdk` entry skips the interactive modes but core still imports some theme/TUI dependencies.
 *
 * Callers must sanitize the process environment first (`sanitizeBrainEnv`): the SDK captures
 * auxiliary directories and ambient provider keys at import time.
 */
export function loadPiSdk() {
  // ESM owns module caching; no mutable cache is shared between runtime instances here.
  return import("@earendil-works/pi-coding-agent/sdk");
}
