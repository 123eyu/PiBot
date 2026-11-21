#!/usr/bin/env node
import { createRequire } from "node:module";

// The brain ships TypeScript sources and uses parameter properties, which Node's strip-only loader
// rejects. jiti (already locked through the desktop build) runs them with no separate CLI build step.
const desktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { createJiti } = createRequire(desktop.resolve("vite/package.json"))("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { main } = await jiti.import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
