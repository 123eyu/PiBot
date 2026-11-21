// Compatibility for scripts calling this file directly; all targets share one packager.
process.argv.splice(2, 0, "--mac");
await import("./package.ts");

export {};
