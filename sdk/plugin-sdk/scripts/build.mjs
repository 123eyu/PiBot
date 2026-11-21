import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

await mkdir("dist", { recursive: true });
const external = (id) =>
  id.startsWith("node:") || id === "zod" || id.startsWith("@modelcontextprotocol/");
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["zod", "@modelcontextprotocol/*"],
});
const declarations = await rollup({
  input: "src/index.ts",
  external,
  plugins: [
    {
      name: "inline-pibot-contract",
      resolveId(id) {
        if (id === "@pibot/protocol-base")
          return fileURLToPath(
            new URL("../../../packages/protocol-base/src/index.ts", import.meta.url),
          );
      },
    },
    dts({
      respectExternal: true,
      compilerOptions: { noCheck: false, disableSourceOfProjectReferenceRedirect: false },
    }),
  ],
});
try {
  await declarations.write({ file: "dist/index.d.ts", format: "es" });
} finally {
  await declarations.close();
}
