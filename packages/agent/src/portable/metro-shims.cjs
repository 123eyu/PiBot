// Pi-ai files that Metro cannot bundle for the phone, mapped to phone stand-ins. pi-ai hides
// its Node-only lookups behind `import(variable)` so browser bundlers skip them; Metro rejects any
// non-literal import() at transform time instead. Used by apps/mobile/metro.config.cjs (swap after
// normal resolution) and tools/dev/portable-graph.ts (same swap, so the graph check sees what the
// phone bundles). CommonJS because Metro's config loads it before any TypeScript tooling.
const path = require("node:path");

const shims = {
  "dist/env-api-keys.js": path.join(__dirname, "shims", "env-api-keys.ts"),
  "dist/auth/context.js": path.join(__dirname, "shims", "auth-context.ts"),
  "dist/utils/provider-env.js": path.join(__dirname, "shims", "provider-env.ts"),
};
const piAiFile = /[\\/]@earendil-works[\\/]pi-ai[\\/](dist[\\/].+)$/u;

/** The phone stand-in for a resolved pi-ai file, or undefined to keep the file. */
function portableShimFor(filePath) {
  const match = piAiFile.exec(filePath);
  return match ? shims[match[1].replaceAll("\\", "/")] : undefined;
}

module.exports = { portableShimFor };
