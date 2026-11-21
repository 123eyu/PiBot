import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CapabilityContext } from "@pibot/brain/kit";
import { pluginInstallTools, RpcError } from "@pibot/plugins-contract/full";
import { BotsRepo } from "@pibot/storage";
import type { ConnectorService } from "./connector-service.ts";

/** Convert model input into a trusted selection only after checking this run's local workplace. */
export function registerPluginInstall(ctx: CapabilityContext, service: ConnectorService) {
  ctx.tools.executor("plugin_install", async (context, call, signal) => {
    if (new BotsRepo(ctx.db).get(context.botId)?.role?.id !== "plugin-builder")
      throw new RpcError(-32602, "plugin_install_role_required");
    signal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const input = pluginInstallTools.plugin_install.schema.parse(call.input);
    const workplace = context.runWorkplace;
    if (workplace?.boundary.location?.target !== "local")
      throw new RpcError(-32602, "plugin_install_local_workplace_required");
    signal.throwIfAborted();
    const primary = workplace.boundary.roots.find(
      (entry) => entry.id === workplace.boundary.primaryId,
    );
    if (
      !primary ||
      workplace.boundary.conflict !== "none" ||
      primary.device === null ||
      primary.inode === null
    )
      throw new RpcError(-32602, "plugin_install_workplace_changed");
    const identity = await stat(primary.canonicalPath, { bigint: true });
    if (String(identity.dev) !== primary.device || String(identity.ino) !== primary.inode)
      throw new RpcError(-32602, "plugin_install_workplace_changed");
    const root = await realpath(workplace.cwd);
    const cwdRelative = relative(primary.canonicalPath, root);
    if (isAbsolute(cwdRelative) || cwdRelative === ".." || cwdRelative.startsWith(`..${sep}`))
      throw new RpcError(-32602, "plugin_install_outside_workplace");
    const path = resolve(root, input.path);
    const rel = relative(root, path);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      (await realpath(path)) !== path ||
      !(await lstat(path)).isDirectory()
    )
      throw new RpcError(-32602, "plugin_install_outside_workplace");
    signal.throwIfAborted();
    return service.installBuiltPlugin(path, input.config ?? {}, context.botId, signal);
  });
}
