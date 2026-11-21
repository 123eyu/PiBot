import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostCall } from "@pibot/brain/kit";
import { normalizeAddress } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import type { Redactor } from "@pibot/secrets";
import {
  type BrowserHostMethods,
  type BrowserRecordEvent,
  type BrowserRules,
  type Events,
  type Methods,
  type Peer,
  type Recording,
  RpcErrorCodes,
  type SkillDraft,
  SkillDraftSchema,
  TEACH_MAX_MS,
} from "@pibot/skills-contract/full";
import { BotsRepo } from "@pibot/storage";
import type { z } from "zod";
import { RecordingsRepo } from "../../store/index.ts";
import { teachError } from "./teach-draft.ts";
import {
  keepKeyframes,
  keyframeEvents,
  readThumbnail,
  removeTeachDir,
  settleKeyframes,
  stepShot,
  teachDir,
} from "./teach-files.ts";
import type { TeachSkills } from "./teach-skill.ts";
import { synthesizeSteps } from "./teach-steps.ts";
import { skillDocument, trialMessage } from "./teach-text.ts";

type SkillDraftInput = z.input<typeof SkillDraftSchema>;
const POLL_MS = 1000;
const HOST_TIMEOUT_MS = 30_000;
const DRAFT_TIMEOUT_MS = 120_000;

interface Active {
  recording: Recording;
  started: number;
  events: BrowserRecordEvent[];
  perStep: number[][];
  shots: Set<number>;
  paused: boolean;
  key: string;
  rules: BrowserRules;
  timer?: ReturnType<typeof setTimeout>;
  polling?: Promise<void>;
}

export interface TeachDeps {
  db: ConstructorParameters<typeof RecordingsRepo>[0];
  dataDir: string;
  host: HostCall<typeof BrowserHostMethods> | undefined;
  /** Takeover through the overlay service so `browser.state` stays right. */
  takeover(botId: string, on: boolean): Promise<unknown>;
  /** The Bot's network allowlist and proxy; teaching follows the same network rules. */
  network(botId: string): Pick<BrowserRules, "allowList" | "proxy">;
  drafter(recording: Recording, signal: AbortSignal): Promise<SkillDraft>;
  skills: TeachSkills;
  /** Starts the trial as an ordinary message in a new topic of the Bot. */
  startTrial(botId: string, text: string): Promise<{ runId: string; topicId?: string }>;
  language(): "zh" | "en";
  peer: Pick<Peer<typeof Methods, typeof Events>, "emit">;
  redactor: Redactor;
  logger: Logger;
  shutdown: AbortSignal;
}

/**
 * "Teach it once": records the user driving the Bot browser, turns the events
 * into reviewable steps, drafts a skill from the kept steps only and saves it through the skill
 * store. Owns one poll timer per active recording; `dispose` clears them.
 */
export class TeachService {
  private readonly repo: RecordingsRepo;
  private readonly bots: BotsRepo;
  private readonly active = new Map<string, Active>();
  private readonly drafting = new Set<string>();
  /** Bots whose start is still opening the browser; their row is not in `active` yet. */
  private readonly starting = new Set<string>();
  private closing = false;

  constructor(private readonly deps: TeachDeps) {
    this.repo = new RecordingsRepo(deps.db);
    this.bots = new BotsRepo(deps.db);
  }

  /** Startup: a recording cannot outlive the browser that made it; old pictures go. */
  async recover() {
    const failed = this.repo.failActive();
    if (failed) this.deps.logger.warn(`Teach recordings interrupted count=${failed}`);
    const root = join(this.deps.dataDir, "bots");
    for (const botId of await readdir(root).catch(() => [] as string[])) {
      for (const id of await readdir(join(root, botId, "teach")).catch(() => [] as string[])) {
        const status = this.repo.get(id)?.status;
        // "recording" here can only be one started after failActive above (this runs async).
        if (status !== "recording" && status !== "review" && status !== "drafted")
          await removeTeachDir(teachDir(this.deps.dataDir, botId, id));
      }
    }
  }

  isIdle() {
    return this.active.size === 0 && this.drafting.size === 0 && this.starting.size === 0;
  }

  private get host() {
    if (!this.deps.host) throw teachError("browser_unavailable", RpcErrorCodes.unsupported);
    return this.deps.host;
  }
  private signal(ms = HOST_TIMEOUT_MS) {
    return AbortSignal.any([this.deps.shutdown, AbortSignal.timeout(ms)]);
  }
  private find(recordingId: string) {
    const recording = this.repo.get(recordingId);
    if (!recording) throw teachError("teach_not_found");
    return recording;
  }

  private live(botId: string) {
    return [...this.active.values()].find((a) => a.recording.botId === botId);
  }

  /**
   * What the teach page offers on entry. Only the newest unfinished recording is ever offered,
   * so older ones (left from before start refused a second one) are unreachable and go.
   */
  async current(botId: string): Promise<Recording | null> {
    const live = this.live(botId);
    if (live) return live.recording;
    // Another page is between creating the row and taking the browser over; leave it alone.
    if (this.starting.has(botId)) return this.repo.active(botId) ?? null;
    const resumable: Recording[] = [];
    for (const recording of this.repo.unfinished(botId)) {
      // A "recording" row nothing polls outlived its browser (brain restarted).
      if (recording.status === "recording") this.repo.setStatus(recording.id, "failed");
      else resumable.push(recording);
    }
    // No recording here, so the host must not be recording either: page and host agree.
    if (this.deps.host) await this.releaseOrphan(botId);
    const [newest, ...older] = resumable;
    for (const recording of older) await this.discard(recording.id);
    return newest ?? null;
  }

  async start(botId: string, url: string | undefined) {
    const host = this.host;
    const bot = this.bots.get(botId);
    if (!bot || bot.archivedAt) throw teachError("teach_bot_unknown");
    if (bot.category === "image") throw teachError("teach_bot_unsupported");
    const current = this.live(botId);
    // A new address while another page records (or is starting) would silently join or replace
    // that recording; the page asks the user instead.
    if (this.starting.has(botId) || (current && url))
      throw teachError("teach_unfinished", RpcErrorCodes.busy);
    if (current) {
      // Coming back to the page: the overlay's takeover path may have pushed the Bot's ordinary
      // rules meanwhile, and the user's reloads must load under the recording's own.
      await host.call("host.browser.configure", { botId, rules: current.rules }, this.signal());
      // The returning page learns the pause state and elapsed time from this event.
      this.progress(current.recording, current);
      return current.recording;
    }
    this.starting.add(botId);
    try {
      const stale = this.repo.active(botId);
      if (stale) this.repo.setStatus(stale.id, "failed");
      await this.releaseOrphan(botId);
      const address = url ? normalizeAddress(url) : "";
      if (!/^https?:\/\/[^/]/i.test(address)) throw teachError("teach_url_required");
      if (this.repo.unfinished(botId).length)
        throw teachError("teach_unfinished", RpcErrorCodes.busy);
      return await this.open(botId, address);
    } finally {
      this.starting.delete(botId);
    }
  }

  private async open(botId: string, address: string) {
    const host = this.host;
    const recording = this.repo.start(botId);
    const signal = this.signal();
    const rules: BrowserRules = {
      ...this.deps.network(botId),
      // The user drives: takeover skips site and submit prompts, never the allowlist.
      sites: [],
      submitSites: [],
      readRoots: [],
      downloadsDir: join(teachDir(this.deps.dataDir, botId, recording.id), "downloads"),
    };
    try {
      await host.call("host.browser.configure", { botId, rules }, signal);
      // Recording first, so the opening navigation is the first step.
      await host.call("host.browser.record.start", { botId, recordingId: recording.id }, signal);
      await host.call("host.browser.open", { botId, url: address }, signal);
      await this.deps.takeover(botId, true);
      // The takeover may push the Bot's last run rules (no download folder, an old proxy).
      await host.call("host.browser.configure", { botId, rules }, signal);
      signal.throwIfAborted();
    } catch (error) {
      await host
        .call("host.browser.record.stop", { botId }, AbortSignal.timeout(HOST_TIMEOUT_MS))
        .catch(() => {
          // The page never opened or the host is gone; there is nothing left to stop.
        });
      await this.deps.takeover(botId, false).catch(() => {
        // A failed start must also release a takeover completed just before cancellation.
      });
      this.repo.setStatus(recording.id, "failed");
      await removeTeachDir(teachDir(this.deps.dataDir, botId, recording.id));
      throw error;
    }
    const active: Active = {
      recording,
      started: Date.now(),
      events: [],
      perStep: [],
      shots: new Set(),
      paused: false,
      key: "[]",
      rules,
    };
    this.active.set(recording.id, active);
    this.deps.logger.info(`Teach recording started botId=${botId}`);
    this.schedule(active);
    this.progress(active.recording, active);
    return recording;
  }

  /**
   * The host can still be recording, under takeover, with no recording here (brain restarted
   * while the browser host lived on, or a stop never reached it). Such a leftover would lend its
   * events (clicks on an old error page) to the next recording and keep the takeover banner up,
   * so it is ended before a new start or before the start form shows.
   */
  private async releaseOrphan(botId: string) {
    const host = this.host;
    const signal = this.signal();
    const read = await host
      .call("host.browser.record.read", { botId, after: 0 }, signal)
      .catch(() => undefined);
    if (!read?.active) return;
    this.deps.logger.warn(`Teach orphan recording released botId=${botId}`);
    await host.call("host.browser.record.stop", { botId }, signal).catch(() => {
      // Pages gone meanwhile: nothing left recording.
    });
    await this.deps.takeover(botId, false).catch(() => {
      // Already handed back or the pages closed.
    });
  }

  private schedule(active: Active) {
    if (this.closing) return;
    active.timer = setTimeout(() => {
      active.polling = this.poll(active).finally(() => {
        active.polling = undefined;
        if (this.active.get(active.recording.id) === active) this.schedule(active);
      });
    }, POLL_MS);
  }

  private async poll(active: Active) {
    const { botId, id } = active.recording;
    try {
      if (Date.now() - active.started >= TEACH_MAX_MS) {
        await this.finish(active);
        return;
      }
      const read = await this.host.call(
        "host.browser.record.read",
        { botId, after: active.events.length },
        this.signal(),
      );
      active.events.push(...read.events);
      if (!read.active) {
        // Pages closed under the recording (brain restart, browser data cleared): keep what we have.
        await this.finish(active);
        return;
      }
      if (this.active.get(id) !== active) return;
      const shots = await keyframeEvents(teachDir(this.deps.dataDir, botId, id));
      // Nothing new (the user is reading or thinking): skip re-synthesizing every second.
      if (!read.events.length && shots.size === active.shots.size) return;
      active.shots = shots;
      this.refresh(active);
    } catch {
      this.deps.logger.warn(`Teach poll failed botId=${botId}`);
    }
  }

  private refresh(active: Active) {
    const { steps, events } = synthesizeSteps(
      active.events,
      (t) => this.deps.redactor.redact(t),
      this.deps.language(),
    );
    const pictured = steps.map((step, i) => ({
      ...step,
      hasThumbnail: stepShot(events[i] ?? [], active.shots) !== undefined,
    }));
    const key = JSON.stringify(pictured);
    if (key === active.key) return;
    active.key = key;
    active.perStep = events;
    active.recording = this.repo.saveSteps(active.recording.id, pictured);
    this.progress(active.recording, active);
  }

  private progress(recording: Recording, active?: Active) {
    const last = recording.steps.at(-1);
    this.deps.peer.emit("teach.progress", {
      recordingId: recording.id,
      botId: recording.botId,
      status: recording.status,
      elapsedMs: Math.min(
        TEACH_MAX_MS,
        Math.max(0, Date.now() - (active?.started ?? Date.parse(recording.startedAt))),
      ),
      maxMs: TEACH_MAX_MS,
      stepCount: recording.steps.length,
      paused: active?.paused ?? false,
      ...(last ? { lastStep: { kind: last.kind, target: last.target } } : {}),
    });
  }

  async stop(recordingId: string) {
    const active = this.active.get(recordingId);
    if (!active) {
      const recording = this.find(recordingId);
      if (recording.status === "recording") return this.repo.setStatus(recordingId, "failed");
      return recording;
    }
    this.active.delete(recordingId);
    clearTimeout(active.timer);
    // A poll in flight must not write steps after the final list.
    await active.polling;
    // That poll may have hit the time limit and finished the recording itself.
    const now = this.find(recordingId);
    return now.status === "recording" ? this.finish(active) : now;
  }

  /** Final steps and pictures, then review. Callers have removed `active` from the map. */
  private async finish(active: Active) {
    this.active.delete(active.recording.id);
    clearTimeout(active.timer);
    const { botId, id: recordingId } = active.recording;
    const dir = teachDir(this.deps.dataDir, botId, recordingId);
    try {
      const { events } = await this.host.call("host.browser.record.stop", { botId }, this.signal());
      // The full list is authoritative; polled events were only for the live view.
      if (events.length >= active.events.length) active.events = events;
    } catch {
      this.deps.logger.warn(`Teach stop: host unavailable botId=${botId}`);
    }
    const { steps, events } = synthesizeSteps(
      active.events,
      (t) => this.deps.redactor.redact(t),
      this.deps.language(),
    );
    const pictured = await settleKeyframes(dir, events).catch(() => steps.map(() => false));
    this.repo.saveSteps(
      recordingId,
      steps.map((step, i) => ({ ...step, hasThumbnail: pictured[i] === true })),
    );
    const recording = this.repo.setStatus(recordingId, "review");
    await this.deps.takeover(botId, false).catch(() => {
      // Already handed back or the pages closed; nothing to undo.
    });
    this.deps.logger.info(`Teach recording stopped botId=${botId} steps=${recording.steps.length}`);
    this.progress(recording);
    return recording;
  }

  async pause(recordingId: string, paused: boolean) {
    const active = this.active.get(recordingId);
    if (!active) throw teachError("teach_not_recording");
    const { botId } = active.recording;
    await this.host.call("host.browser.record.pause", { botId, paused }, this.signal());
    active.paused = paused;
    this.progress(active.recording, active);
    return { paused };
  }

  review(recordingId: string) {
    return this.active.get(recordingId)?.recording ?? this.find(recordingId);
  }

  async thumbnail(recordingId: string, index: number) {
    const recording = this.review(recordingId);
    const dir = teachDir(this.deps.dataDir, recording.botId, recordingId);
    const active = this.active.get(recordingId);
    const signal = this.signal(10_000);
    if (!active) return readThumbnail(join(dir, `s${index}.jpg`), signal);
    const shot = stepShot(active.perStep[index] ?? [], active.shots);
    if (shot === undefined)
      throw teachError("teach_thumbnail_unavailable", RpcErrorCodes.unsupported);
    return readThumbnail(join(dir, `e${shot}.jpg`), signal);
  }

  /** Only the kept steps go to the model; deletions are stored after a good draft. */
  async draft(recordingId: string, keep: number[]) {
    if (this.drafting.has(recordingId)) throw teachError("teach_busy", RpcErrorCodes.busy);
    const recording = this.find(recordingId);
    const all = recording.steps.map((step) => step.index);
    const wanted = new Set(keep);
    if (keep.some((index) => index >= all.length)) throw teachError("teach_step_unknown");
    if (recording.status === "drafted" && wanted.size !== all.length)
      throw teachError("teach_step_unknown");
    if (recording.status !== "review" && recording.status !== "drafted")
      throw teachError("teach_not_ready");
    this.drafting.add(recordingId);
    try {
      const kept = {
        ...recording,
        steps: recording.steps
          .filter((step) => wanted.has(step.index))
          .map((step, index) => ({ ...step, index })),
      };
      const draft = await this.deps.drafter(kept, this.signal(DRAFT_TIMEOUT_MS));
      if (recording.status === "review") {
        this.repo.keepSteps(recordingId, keep);
        const dir = teachDir(this.deps.dataDir, recording.botId, recordingId);
        await keepKeyframes(dir, all.length, keep);
      }
      this.repo.setStatus(recordingId, "drafted");
      return { draft };
    } finally {
      this.drafting.delete(recordingId);
    }
  }

  async trial(botId: string, input: SkillDraftInput) {
    if (!this.bots.get(botId)) throw teachError("teach_bot_unknown");
    const draft = SkillDraftSchema.parse(input);
    return this.deps.startTrial(botId, trialMessage(draft, this.deps.language()));
  }

  async save(botId: string, input: SkillDraftInput) {
    const draft = SkillDraftSchema.parse(input);
    const recording = draft.recordingId ? this.repo.get(draft.recordingId) : undefined;
    if (recording && recording.botId !== botId) throw teachError("teach_not_found");
    const skill = await this.deps.skills.create(
      botId,
      skillDocument(draft, this.deps.language()),
      "taught",
    );
    if (recording?.status === "drafted") {
      this.repo.setStatus(recording.id, "saved");
      await removeTeachDir(teachDir(this.deps.dataDir, botId, recording.id));
    }
    this.deps.logger.info(`Taught skill saved botId=${botId}`);
    return skill;
  }

  async discard(recordingId: string) {
    const active = this.active.get(recordingId);
    if (active) {
      this.active.delete(recordingId);
      clearTimeout(active.timer);
      await active.polling;
      const { botId } = active.recording;
      await this.host.call("host.browser.record.stop", { botId }, this.signal()).catch(() => {
        // Gone with the pages; the events are being thrown away anyway.
      });
      await this.deps.takeover(botId, false).catch(() => {
        // Already handed back.
      });
    }
    const recording = this.find(recordingId);
    if (recording.status !== "saved" && recording.status !== "discarded") {
      const done = this.repo.setStatus(recordingId, "discarded");
      this.progress(done);
    }
    await removeTeachDir(teachDir(this.deps.dataDir, recording.botId, recordingId));
    return { ok: true as const };
  }

  quiesce() {
    this.closing = true;
    for (const active of this.active.values()) clearTimeout(active.timer);
  }
  async dispose() {
    this.quiesce();
    const recordings = [...this.active.values()];
    await Promise.allSettled(recordings.map((active) => active.polling));
    const results = await Promise.allSettled(
      recordings.map(async (active) => {
        if (this.active.get(active.recording.id) !== active) return;
        // Cleanup has its own deadline: the operation signal is already cancelled on shutdown.
        await this.host.call(
          "host.browser.record.stop",
          { botId: active.recording.botId },
          AbortSignal.timeout(HOST_TIMEOUT_MS),
        );
        await this.deps.takeover(active.recording.botId, false);
        this.repo.setStatus(active.recording.id, "failed");
        this.active.delete(active.recording.id);
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
