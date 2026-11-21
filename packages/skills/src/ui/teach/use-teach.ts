import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useRpcEvent } from "@pibot/renderer-kit";
import {
  type Recording,
  RpcError,
  type Skill,
  type SkillDraft,
  type SkillParam,
} from "@pibot/skills-contract/full";
import { useCallback, useEffect, useRef, useState } from "react";
import { teachErrorKey } from "./step-text.ts";

/**
 * "start": brain has nothing unfinished for the Bot. "resume": brain has an unfinished recording
 * this page did not leave off at (another window, or before a restart), and the user chooses.
 * The rest follow the recording's own status: recording, review, and draft (status "drafted").
 */
export type Stage = "start" | "resume" | "recording" | "review" | "draft";
export interface Trial {
  runId: string;
  topicId?: string;
  status: "running" | "done" | "failed";
}
/** How the last lesson ended, shown on the start stage until "teach another" or leaving. */
export type Outcome =
  | { kind: "saved"; skill: Skill; routine: boolean; params: SkillParam[] }
  | { kind: "discarded" };
export interface TeachSnapshot {
  stage: Stage;
  url: string;
  recording?: Recording;
  /** Step indexes the user removed during review (never sent to the model). */
  removed: number[];
  draft?: SkillDraft;
  routine: boolean;
  trial?: Trial;
  outcome?: Outcome;
  paused: boolean;
  /** Local clock origin of the recording (Date.now() - elapsed). */
  startedAt?: number;
}

const initial = (url = ""): TeachSnapshot => ({
  stage: "start",
  url,
  removed: [],
  routine: false,
  paused: false,
});
/**
 * Per-Bot page state survives leaving the page (e.g. to watch the trial in chat) for this window
 * only; brain keeps the recording itself, the unsaved draft lives only here.
 */
const snapshots = new Map<string, TeachSnapshot>();
const DRAFT_TIMEOUT_MS = 130_000;
/** The trial run the Bot's lesson in this window still waits on: drafted, neither saved nor dropped. */
export const pendingTrialRun = (botId: string) => {
  const snap = snapshots.get(botId);
  return snap?.stage === "draft" ? snap.trial?.runId : undefined;
};
/** Page stages that already show a recording in this status, so re-entry carries on silently. */
const showsStatus: Partial<Record<Recording["status"], readonly Stage[]>> = {
  recording: ["recording"],
  review: ["review"],
  // "review" too: a drafted recording resumed without its draft is reviewed again.
  drafted: ["review", "draft"],
};

export function useTeach(botId: string, peer: Peer) {
  // A finished lesson's result is not kept across visits: coming back starts fresh.
  const [snap, setSnap] = useState<TeachSnapshot>(() => {
    const kept = snapshots.get(botId);
    return kept ? { ...kept, outcome: undefined } : initial();
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const latest = useRef(snap);
  latest.current = snap;
  const update = useCallback(
    (patch: Partial<TeachSnapshot> | ((s: TeachSnapshot) => Partial<TeachSnapshot>)) =>
      setSnap((current) => {
        const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
        snapshots.set(botId, next);
        return next;
      }),
    [botId],
  );
  const reset = useCallback(
    (outcome?: Outcome) => update({ ...initial(latest.current.url), outcome }),
    [update],
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const act = useCallback(async <T>(name: string, operation: () => Promise<T>) => {
    setBusy(name);
    setError(null);
    try {
      return await operation();
    } catch (failure) {
      if (alive.current) setError(teachErrorKey(failure));
      return undefined;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const recorded = useCallback(
    (recording: Recording) => {
      // Another window may discard the recording this page shows, at any stage.
      if (recording.status === "discarded") reset({ kind: "discarded" });
      else if (recording.status === "failed") reset();
      // The prompt only refreshes its step count; the user has not chosen yet.
      else if (latest.current.stage === "resume") update({ recording });
      else if (recording.status === "recording") update({ stage: "recording", recording });
      else if (recording.status === "review")
        update({ stage: "review", recording, removed: [], paused: false });
      else update({ recording });
    },
    [update, reset],
  );

  // Live step list: progress events are coalesced into at most one review read at a time.
  const reading = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const refresh = useCallback(
    async (recordingId: string) => {
      const state = reading.current;
      if (state.busy) {
        state.again = true;
        return;
      }
      state.busy = true;
      try {
        do {
          state.again = false;
          const recording = await peer.call("teach.review", { recordingId });
          if (alive.current && latest.current.recording?.id === recordingId) recorded(recording);
        } while (state.again && alive.current);
      } catch {
        // The next progress event reads again; the strip still shows the count meanwhile.
      } finally {
        state.busy = false;
      }
    },
    [peer, recorded],
  );

  useRpcEvent("teach.progress", (event) => {
    const current = latest.current;
    if (event.botId !== botId || current.recording?.id !== event.recordingId) return;
    update({ paused: event.paused ?? false, startedAt: Date.now() - event.elapsedMs });
    void refresh(event.recordingId);
  });
  useRpcEvent("chat.done", (event) => {
    if (latest.current.trial?.runId === event.runId)
      update((s) => ({ trial: s.trial && { ...s.trial, status: "done" } }));
  });
  useRpcEvent("chat.error", (event) => {
    if (latest.current.trial?.runId === event.runId)
      update((s) => ({ trial: s.trial && { ...s.trial, status: "failed" } }));
  });

  // The trial usually ends while the user watches it in chat, with this page unmounted and its
  // chat.done / chat.error missed; coming back reads the run's state instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page mount and connection
  useEffect(() => {
    const trial = latest.current.trial;
    if (trial?.status !== "running") return;
    const abort = new AbortController();
    void peer
      .call("chat.runs", { botId, limit: 50 }, { signal: abort.signal, timeoutMs: 10_000 })
      .then((runs) => {
        const run = runs.find((r) => r.id === trial.runId);
        const status =
          run?.status === "done"
            ? "done"
            : run?.status === "error" || run?.status === "aborted"
              ? "failed"
              : undefined;
        if (!status || abort.signal.aborted || latest.current.trial?.runId !== trial.runId) return;
        update((s) => ({ trial: s.trial && { ...s.trial, status } }));
      })
      .catch(() => {
        // Still shown as running; a later chat.done / chat.error moves it on.
      });
    return () => abort.abort();
  }, [peer, botId]);

  // Re-attach to the live recording (start without an address only resumes, and brain re-applies
  // its browser rules), then take the browser over again, since leaving the page handed it back
  //. Brain answers with a progress event carrying the pause state and elapsed time.
  const attach = async () => {
    const recording = await peer.call("teach.start", { botId });
    if (!alive.current) return;
    update({
      stage: "recording",
      recording,
      removed: [],
      startedAt: Date.parse(recording.startedAt),
    });
    void peer.call("browser.takeover", { botId, on: true }).catch(() => {
      // Pages closed meanwhile; the next progress event moves the page on.
    });
  };

  // Brain is the authority on what is unfinished: this page's memory of a recording may be stale
  // (brain restarted, another window moved it on). Brain also ends a recording or takeover the
  // browser host still holds with nothing behind it, so the start form never meets a leftover.
  const reconcile = async (): Promise<void> => {
    const found = await peer.call("teach.current", { botId });
    if (!alive.current) return;
    const local = latest.current;
    if (!found) {
      if (local.stage !== "start") reset();
      return;
    }
    if (local.recording?.id === found.id && showsStatus[found.status]?.includes(local.stage)) {
      if (found.status !== "recording") return;
      try {
        await attach();
      } catch {
        // It ended between the read and the attach; read again to show what is left.
        if (!alive.current) return;
        reset();
        await reconcile();
      }
      return;
    }
    update({ ...initial(local.url), stage: "resume", recording: found });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page mount and connection
  useEffect(() => {
    void act("check", reconcile);
  }, [peer, botId]);

  return {
    snap,
    busy,
    error,
    clearError: () => setError(null),
    update,
    start: (url: string) =>
      act("start", async () => {
        try {
          const recording = await peer.call("teach.start", { botId, url: url.trim() });
          update({
            ...initial(url),
            stage: "recording",
            recording,
            startedAt: Date.now(),
          });
        } catch (failure) {
          if (!(failure instanceof RpcError) || failure.message !== "teach_unfinished")
            throw failure;
          // Started elsewhere since this page checked: offer it instead of overwriting it.
          update({ url });
          await reconcile();
          throw failure;
        }
      }),
    continueLast: () => {
      const recording = latest.current.recording;
      if (!recording) return;
      void act("resume", async () => {
        if (recording.status === "recording") {
          try {
            await attach();
          } catch (failure) {
            await reconcile();
            throw failure;
          }
          return;
        }
        // A drafted recording's draft lived only in the page that wrote it: review and write
        // it up again (brain then accepts only all of its already-kept steps).
        const now = await peer.call("teach.review", { recordingId: recording.id });
        if (now.status !== "review" && now.status !== "drafted") return reconcile();
        update({ stage: "review", recording: now, removed: [], paused: false });
      });
    },
    restart: () => {
      const recording = latest.current.recording;
      void act("restart", async () => {
        if (recording) await peer.call("teach.discard", { recordingId: recording.id });
        reset();
        await reconcile();
      });
    },
    pause: () => {
      const { recording, paused } = latest.current;
      if (!recording) return;
      void act("pause", async () => {
        const result = await peer.call("teach.pause", {
          recordingId: recording.id,
          paused: !paused,
        });
        update({ paused: result.paused });
      });
    },
    finish: () => {
      const recording = latest.current.recording;
      if (!recording) return;
      void act("finish", async () =>
        recorded(await peer.call("teach.stop", { recordingId: recording.id })),
      );
    },
    /** `announce`: the user gave up on this lesson (not "record again"), so say it ended. */
    discard: (announce: boolean) => {
      const recording = latest.current.recording;
      void act("discard", async () => {
        if (recording) await peer.call("teach.discard", { recordingId: recording.id });
        reset(announce ? { kind: "discarded" } : undefined);
      });
    },
    toggleStep: (index: number) =>
      update((s) => ({
        removed: s.removed.includes(index)
          ? s.removed.filter((i) => i !== index)
          : [...s.removed, index],
      })),
    draftIt: () => {
      const { recording, removed } = latest.current;
      if (!recording) return;
      const keep = recording.steps.map((s) => s.index).filter((i) => !removed.includes(i));
      if (!keep.length) return;
      void act("draft", async () => {
        const { draft } = await peer.call(
          "teach.draft",
          { recordingId: recording.id, keep },
          { timeoutMs: DRAFT_TIMEOUT_MS },
        );
        const kept = {
          ...recording,
          status: "drafted" as const,
          steps: recording.steps.filter((s) => keep.includes(s.index)),
        };
        update({ stage: "draft", draft, recording: kept, removed: [], trial: undefined });
      });
    },
    trial: () => {
      const draft = latest.current.draft;
      if (!draft) return;
      void act("trial", async () => {
        const result = await peer.call("teach.trial", { botId, draft });
        update({ trial: { ...result, status: "running" } });
      });
    },
    save: () => {
      const { draft, routine } = latest.current;
      if (!draft) return;
      void act("save", async () => {
        const skill = await peer.call("teach.save", {
          botId,
          draft: { ...draft, trigger: routine ? "routine" : "chat" },
        });
        reset({ kind: "saved", skill, routine, params: draft.params });
      });
    },
    again: () => update({ outcome: undefined }),
  };
}
