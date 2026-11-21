import { posix, win32 } from "node:path";
import { ProjectNotesRepo, transaction } from "@pibot/storage";
import type { PreparedToolView } from "@pibot/tools/runtime";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { notesHash } from "./project-notes-edit.ts";

export function observeProjectNotes(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedToolView,
  path: string,
  text: string,
  ownWrite = false,
) {
  const root = prepared.boundary?.roots.find((entry) => entry.role === "primary");
  const location = prepared.boundary?.location;
  const paths = (location?.platform ?? local.deps.platform) === "win32" ? win32 : posix;
  if (
    !root ||
    !["AGENTS.md", "CLAUDE.md"].some((name) => path === paths.join(root.canonicalPath, name))
  )
    return;
  context.signal.throwIfAborted();
  transaction(local.deps.db, () => {
    const changed = new ProjectNotesRepo(local.deps.db).observe(
      notesHash(
        JSON.stringify([
          location?.target ?? "local",
          root.canonicalPath,
          root.device,
          root.inode,
          paths.basename(path),
        ]),
      ),
      notesHash(text),
    );
    if (changed && !ownWrite)
      local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "file.read",
        summary: "项目说明有变化 / Project instructions changed",
        detail: { reasonCode: "project_notes_changed" },
      });
  });
}
