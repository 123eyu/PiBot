import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSkillsHost } from "@pibot/brain/kit";

/**
 * Replaced shared plugin skills with per-Bot / per-group copies, so nothing registers
 * here any more. Files materialized by older versions may still sit under `plugin-skills/`;
 * uninstall (and its recovery replay) still removes them.
 */
export class PluginSkillHost implements PluginSkillsHost {
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async remove(installationId: string): Promise<void> {
    // Serialize per installation: a replayed uninstall must not race the first one's rm.
    const previous = this.operationTails.get(installationId) ?? Promise.resolve();
    const result = previous.then(() =>
      rm(join(this.root, installationId), { recursive: true, force: true }),
    );
    const tail = result.catch(() => undefined);
    this.operationTails.set(installationId, tail);
    void tail.then(() => {
      if (this.operationTails.get(installationId) === tail)
        this.operationTails.delete(installationId);
    });
    await result;
  }
}
