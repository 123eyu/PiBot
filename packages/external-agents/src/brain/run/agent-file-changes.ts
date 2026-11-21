import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";

/** Permission is not completion: preserve the first before-image, then inspect after ACP settles. */
export function agentFileChanges(local: LocalService, context: ToolRunContext) {
  const pending = new Map<
    string,
    { root: string; before: ReturnType<typeof local.changes.turn.beforeWrite> }
  >();
  return {
    async before(path: string) {
      const canonical = await realpath(path).catch(async () =>
        join(await realpath(dirname(path)), basename(path)),
      );
      const root = context.runWorkplace?.boundary.writeRoots.find((root) =>
        containsPath(root, canonical, local.deps.platform),
      );
      if (!root || pending.has(canonical) || pending.size >= 500) return;
      pending.set(canonical, {
        root,
        before: local.changes.turn.beforeWrite(context, canonical),
      });
      await pending.get(canonical)?.before;
    },
    async finish() {
      for (const [path, { root, before }] of pending)
        await local.changes.turn.afterWrite(context, await before, path, root);
      pending.clear();
    },
  };
}
