import { join } from "node:path";
import type { PackageArch } from "./package-options.ts";
import { verifyTargetBinary } from "./verify-target-binary.ts";

/** Excluding other targets must still leave the native modules needed by this target. */
export function verifyNativePrebuilds(archive: string, platform: string, arch: PackageArch) {
  const modules = join(`${archive}.unpacked`, "node_modules");
  const target = `${platform}-${arch}`;
  for (const file of [
    join(modules, "tree-sitter-bash", "prebuilds", target, "tree-sitter-bash.node"),
    join(
      modules,
      "@earendil-works",
      "pi-tui",
      "native",
      platform,
      "prebuilds",
      target,
      `${platform}-platform${platform === "linux" ? "-x11" : ""}.node`,
    ),
    ...(platform === "linux"
      ? [
          join(
            modules,
            "@anthropic-ai",
            "sandbox-runtime",
            "vendor",
            "seccomp",
            arch,
            "apply-seccomp",
          ),
        ]
      : []),
  ])
    verifyTargetBinary(file, platform, arch);
}
