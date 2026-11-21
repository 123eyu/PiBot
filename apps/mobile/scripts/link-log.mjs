// The phone's link log (fixed-code JSON on console.info/warn) captured for measurements:
// connect stage timings and how each connect refreshed (resumed vs full).
export function captureLinkLog({ echo = false } = {}) {
  const entries = [];
  const original = { info: console.info, warn: console.warn };
  const wrap =
    (level) =>
    (line, ...rest) => {
      if (typeof line === "string" && line.startsWith("{")) {
        try {
          const value = JSON.parse(line);
          if (value.module === "mobile-link") {
            entries.push({ ...value, at: Date.now() });
            if (!echo) return;
          }
        } catch {
          // Not one of ours; printed as is.
        }
      }
      original[level](line, ...rest);
    };
  console.info = wrap("info");
  console.warn = wrap("warn");
  const since = (mark) => entries.slice(mark);
  return {
    entries,
    mark: () => entries.length,
    since,
    /** The first `events_resume` entry after `mark` (how that connect refreshed), if any. */
    resume: (mark) => since(mark).find((entry) => entry.event === "events_resume"),
    /** One line per connect after `mark`: stage → ms, as the phone logged them. */
    summary(label, mark) {
      const stages = {};
      for (const entry of since(mark)) {
        if (entry.event === "connect_stage" && !(entry.stage in stages))
          stages[entry.stage] = entry.ms;
        if (entry.event === "session_opened" && stages.session_opened === undefined)
          stages.session_opened = entry.connectMs;
        if (entry.event === "session_drain_slow" && stages.drain_slow === undefined)
          stages.drain_slow = entry.ms;
      }
      const resume = since(mark).find((entry) => entry.event === "events_resume");
      const parts = Object.entries(stages).map(([stage, ms]) => `${stage}=${ms}`);
      if (resume) parts.push(`refresh=${resume.mode}`, `replayed=${resume.replayed}`);
      original.info(`MEASURE ${label}: ${parts.join(" ")}`);
      return { stages, resume };
    },
    restore() {
      console.info = original.info;
      console.warn = original.warn;
    },
  };
}
