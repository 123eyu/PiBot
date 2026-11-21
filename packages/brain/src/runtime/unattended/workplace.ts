import type { FolderSelection } from "@pibot/protocol-base";
import type { UnattendedTrigger, UnattendedWorkplace } from "../../core/capability.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import type { SelectionContext } from "../../resources/workplaces/workplaces.ts";

type Triggers = readonly UnattendedTrigger[];
const config = (trigger: Triggers[number]) => ("config" in trigger ? trigger.config : trigger);

/**
 * What a saved routine runs in. Its own folder is the primary; its references and the
 * folders its triggers watch are read-only.
 */
export function routineWorkplace(
  local: LocalService,
  botId: string,
  draft: { workplace: UnattendedWorkplace; triggers: Triggers },
): NonNullable<ToolRunContext["routineWorkplace"]> {
  if (draft.workplace.kind === "bot") return { kind: "bot" };
  const watched = new Set(
    draft.triggers.flatMap((t) => {
      const value = config(t);
      return value.kind === "folder" && typeof value.path === "string" ? [value.path] : [];
    }),
  );
  const monitors = local.workplaces.repo.idsForPaths(botId, [...watched]);
  const primary = draft.workplace.folderId;
  return {
    kind: "folder",
    folderId: primary,
    readonly: [...new Set([...(draft.workplace.readonly ?? []), ...monitors])]
      .filter((id) => id !== primary)
      .slice(0, 32),
    ...(draft.workplace.cwd ? { cwd: draft.workplace.cwd } : {}),
  };
}

/** The routine's folders as a selection (revision 0: see run-workplace `routineSelection`). */
export function routineSelectionFor(
  local: LocalService,
  draft: { botId: string; workplace?: UnattendedWorkplace; triggers: Triggers },
): SelectionContext {
  const workplace = explicitWorkplace(local, draft.botId, draft.workplace ?? { kind: "bot" });
  const place = routineWorkplace(local, draft.botId, { workplace, triggers: draft.triggers });
  return {
    selection: { primary: place.folderId ?? "home", readonly: place.readonly ?? [] },
    revision: 0,
  };
}

/** `{kind:"bot"}` is saved as the folders a new topic would get (the previous topic's). */
export function explicitWorkplace(
  local: LocalService,
  botId: string,
  workplace: UnattendedWorkplace,
): UnattendedWorkplace {
  if (workplace.kind === "folder") return workplace;
  const selection: FolderSelection = local.workplaces.initial(botId);
  return { kind: "folder", folderId: selection.primary, readonly: selection.readonly };
}
