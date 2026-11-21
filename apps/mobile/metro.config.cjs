const { getDefaultConfig } = require("expo/metro-config");
const { portableShimFor } = require("@pibot/agent/portable/metro-shims");
const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, name, platform) => {
  // markdown-it 10 uses the Node module name; only this pure-JS IDNA implementation is needed.
  if (name === "punycode") return { type: "sourceFile", filePath: require.resolve("punycode/") };
  const resolved = context.resolveRequest(context, name, platform);
  // Pi-ai's Node-only lookups (`import(variable)`) swapped for phone stand-ins; only reached
  // when a bundle imports @pibot/agent/portable.
  const shim = resolved.type === "sourceFile" ? portableShimFor(resolved.filePath) : undefined;
  return shim ? { type: "sourceFile", filePath: shim } : resolved;
};
module.exports = config;
