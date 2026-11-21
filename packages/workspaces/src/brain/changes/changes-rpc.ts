import type { RegisterRpc } from "@pibot/brain/kit";
import type { ChangesService } from "./changes-service.ts";
import { listRefs, writeRef } from "./git/changes-refs.ts";
import { listRemotes } from "./git/changes-remotes.ts";
import { changesStatus } from "./git/changes-status.ts";
import { syncRemote } from "./git/changes-sync.ts";
import { changesImage, changesLines } from "./review/changes-content.ts";
import {
  changesLog,
  commitDiff,
  turnDiff,
  turnFiles,
  uncommittedDiff,
} from "./review/changes-diff.ts";
import { discardOffice, withOffice } from "./review/changes-office.ts";
import { revealChangedFile } from "./review/changes-reveal.ts";
import {
  listReviewers,
  listReviews,
  setReviewer,
  startReview,
  updateReviews,
} from "./review/changes-review.ts";
import { commit, discard } from "./write/changes-write.ts";

/** Registered through brain's single RPC wrapper (validation, redacted logging, error mapping). */
export function registerChangesRpc(handle: RegisterRpc, changes: ChangesService) {
  handle("changes.reveal", (params, context) =>
    revealChangedFile(changes, params, AbortSignal.any([context.signal, changes.signal(20_000)])),
  );
  handle("changes.remotes", (params) => listRemotes(changes, params, changes.signal()));
  handle("changes.sync", (params) => syncRemote(changes, params, changes.signal(180_000)));
  handle("changes.refs", (params) => listRefs(changes, params, changes.signal()));
  handle("changes.refWrite", (params) => writeRef(changes, params, changes.signal(180_000)));
  handle("changes.status", (params) => changesStatus(changes, params, changes.signal()));
  handle("changes.diff", async (params, context) => {
    // Comparing two document versions parses both sides, so it needs its own budget.
    const signal = AbortSignal.any([context.signal, changes.signal(120_000)]);
    const scope = await changes.scope(params, signal);
    const diff =
      params.scope === "turn"
        ? await turnDiff(changes, scope, params.runId as string, params.path, signal)
        : params.scope === "commit"
          ? await commitDiff(changes, scope, params.commit as string, params.path, signal)
          : await uncommittedDiff(changes, scope, params.path, signal);
    return withOffice(changes, scope, params, diff, signal);
  });
  handle("changes.turn", (params) => turnFiles(changes, params, changes.signal()));
  handle("changes.log", (params) => changesLog(changes, params, changes.signal()));
  handle("changes.discard", (params) => discard(changes, params, changes.signal(180_000)));
  handle("changes.discardOffice", (params) =>
    discardOffice(changes, params, changes.signal(180_000)),
  );
  handle("changes.commit", (params) => commit(changes, params, changes.signal(180_000)));
  handle("changes.draftMessage", (params) => changes.draftMessage(params, changes.signal()));
  handle("changes.watch", (params) => changes.watch(params, changes.signal()));
  // Unchanged lines, image thumbnails and review findings.
  handle("changes.lines", (params, context) =>
    changesLines(changes, params, AbortSignal.any([context.signal, changes.signal()])),
  );
  handle("changes.image", (params) => changesImage(changes, params, changes.signal()));
  handle("changes.reviews", (params) => listReviews(changes, params, changes.signal()));
  handle("changes.reviewStart", (params) => startReview(changes, params, changes.signal()));
  handle("changes.reviewUpdate", (params) => updateReviews(changes, params, changes.signal()));
  handle("changes.reviewers", (params) => listReviewers(changes, params, changes.signal()));
  handle("changes.reviewerSet", (params) => setReviewer(changes, params, changes.signal()));
}
