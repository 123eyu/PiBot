import { type useAction, useRpc } from "@pibot/renderer-kit";
import type { SkillDocument, SkillFileChange } from "@pibot/skills-contract/full";
import { useRef } from "react";
import { skillError } from "./presentation.ts";

/**
 * Saves an edited package (SKILL.md + file changes) in one `skills.update`. A retry of the same
 * edit reuses the request id, so an update that landed before the reply was lost is not repeated.
 * Shared by the skill's details and the connections page, which both edit the same copy.
 */
export function useSkillUpdate(
  task: ReturnType<typeof useAction>,
  skillId: string,
  groupId: string | undefined,
) {
  const { peer } = useRpc();
  const attempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  return async (next: SkillDocument, files?: SkillFileChange[]): Promise<boolean> => {
    if (!peer) return false;
    const key = JSON.stringify({ next, files });
    const current =
      attempt.current?.key === key ? attempt.current : { key, requestId: crypto.randomUUID() };
    attempt.current = current;
    const result = await task.run(
      (signal) =>
        peer.call(
          "skills.update",
          {
            groupId,
            skillId,
            requestId: current.requestId,
            patch: next,
            ...(files ? { files } : {}),
          },
          { signal },
        ),
      skillError,
    );
    if (!result) return false;
    attempt.current = undefined;
    return true;
  };
}
