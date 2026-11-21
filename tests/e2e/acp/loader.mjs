import { createRequire } from "node:module";

// Reuse the locked Vite loader: the ACP target imports workspace classes with parameter properties.
const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti");
await createJiti(import.meta.url, { fsCache: false }).import("./index.ts");
