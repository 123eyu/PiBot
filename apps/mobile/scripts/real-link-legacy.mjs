import { execFileSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Historical adapter and link implementation; the current brain still owns the real gateway/DB.
export async function legacyDesktopLink(repo, root, ref) {
  const outfile = join(root, "desktop-link.mjs");
  await build({
    entryPoints: [join(repo, "packages/remote/src/brain/link/adapter.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    plugins: [
      {
        name: "historical-desktop-link",
        setup(builder) {
          builder.onResolve({ filter: /^@pibot\/link(?:\/room)?$/ }, (args) => ({
            path: join(
              repo,
              args.path.endsWith("/room")
                ? "packages/link/src/room/index.ts"
                : "packages/link/src/index.ts",
            ),
          }));
          builder.onResolve({ filter: /^[^./]/ }, (args) => ({
            path: isBuiltin(args.path)
              ? args.path
              : createRequire(join(args.resolveDir, "probe.cjs")).resolve(args.path),
            external: true,
          }));
          builder.onLoad({ filter: /\.ts$/ }, (args) => {
            const path = relative(repo, args.path).replaceAll("\\", "/");
            return {
              contents: execFileSync("git", ["show", `${ref}:${path}`], {
                cwd: repo,
                encoding: "utf8",
              }),
              loader: "ts",
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  return (await import(pathToFileURL(outfile).href)).createRemoteLink;
}
