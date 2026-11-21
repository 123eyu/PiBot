import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExecutionTarget, sensitiveReadBoundary } from "@pibot/execution";
import { createPolicy } from "@pibot/policy";
import {
  type RunnerPolicyPreparation,
  RunnerPolicyPreparationSchema,
  RunnerPreparedFactsSchema,
} from "@pibot/protocol-base";

/** Owns the parser; filesystem facts are prepared on the target, final policy runs on the phone. */
export async function createRunnerPolicyFacts(options: {
  target: ExecutionTarget;
  platform: "darwin" | "linux" | "win32";
  home: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
}) {
  // The single executable has no node_modules: its parser wasm ships in resources/wasm.
  const packaged = join(dirname(process.execPath), "resources");
  const policy = await createPolicy({
    platform: options.platform,
    userHome: options.home,
    ...(existsSync(join(packaged, "wasm", "tree-sitter-bash.wasm"))
      ? { resourcesDir: packaged }
      : {}),
  });
  const boundary = await sensitiveReadBoundary(options.platform, [options.home], options.env);
  return {
    dispose: () => policy.dispose(),
    async prepare(raw: RunnerPolicyPreparation, parent: AbortSignal) {
      const value = RunnerPolicyPreparationSchema.parse(raw);
      const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
      const { context, request } = value;
      if (context.boundary.location?.platform !== options.platform)
        throw new Error("runner_platform_changed");
      for (const root of context.boundary.roots) {
        const current = await options.target.canonicalizePath(root.path, request.cwd, signal);
        if (
          current.path !== root.canonicalPath ||
          current.device !== root.device ||
          current.inode !== root.inode
        )
          throw new Error("workspace_boundary_changed");
      }
      const protectedRoots = [options.dataDir, ...boundary.denyRead];
      const prepared = await policy.prepare({
        botId: context.botId,
        request:
          request.category === "run_command"
            ? request
            : { category: request.category, path: request.path },
        settings: context.settings,
        botOverrides: context.overrides,
        workplace: context.workplace,
        boundary: context.boundary,
        cwd: request.cwd,
        signal,
        sensitiveReadRoots: boundary.denyRead,
        realpath: async (path, active) => {
          const value = await options.target.canonicalizePath(path, request.cwd, active);
          if (value.device === null || value.inode === null)
            throw Object.assign(new Error("policy_path_missing"), { code: "ENOENT" });
          return value.path;
        },
        protectedWriteRoots: async () => protectedRoots,
        commandProtectionRoots: async () => protectedRoots,
      });
      // Hooks/config execution needs the desktop's managed entry workflow. The phone never
      // substitutes a signature or an ordinary approval for that missing workflow.
      if (
        request.category === "run_command" &&
        (prepared.result.analysis?.commands.some((c) =>
          /(?:^|[\\/])git(?:\.exe)?$/i.test(c.program),
        ) ||
          /(?:^|[\s;&|])git(?:\.exe)?(?:[\s;&|]|$)/i.test(request.command))
      ) {
        prepared.result.decision = "deny";
        prepared.result.reason = "phone_git_entry_unsupported";
      }
      if (
        request.category === "write_file" &&
        /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(prepared.result.path?.path ?? request.path)
      ) {
        prepared.result.decision = "deny";
        prepared.result.reason = "phone_git_entry_unsupported";
      }
      // The snapshot's roots, not a lexical client path, are the ceiling even for read calls.
      if (prepared.outside || prepared.result.outsideWrites?.length) {
        prepared.result.decision = "deny";
        prepared.result.reason = "outside_workplace";
      }
      signal.throwIfAborted();
      return RunnerPreparedFactsSchema.parse(prepared);
    },
  };
}
