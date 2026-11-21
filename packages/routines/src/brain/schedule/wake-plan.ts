import { lstat, realpath } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { fileIdentity, sameFile, type WakeSource } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";
import { type WakePlan, WakePlanSchema } from "@pibot/protocol";
import { nextCron } from "@pibot/scheduler";
import type { RoutineWakeRepo } from "../../store/index.ts";
import type { RoutineService } from "../service.ts";
import { appTriggerDueAt } from "../triggers/app-triggers.ts";

type Trigger = ReturnType<RoutineWakeRepo["triggers"]>[number];
interface Context {
  plan: WakePlan;
  routines: RoutineService;
  signal: AbortSignal;
  now: number;
  active: boolean;
  dataRoot?: string;
  identities: Map<string, { dev: string; ino: string }>;
}
const earlier = (a: string | null, b: string) => (a === null || b < a ? b : a);

async function folderIdentity(path: string, signal: AbortSignal) {
  const stat = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  signal.throwIfAborted();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== path ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFile(stat, after)
  )
    throw new Error("wake_folder_changed");
  // The background host re-checks with the same canonical spelling (background-light-watch).
  const identity = fileIdentity(stat);
  return { dev: identity.device, ino: identity.inode };
}
async function addFolder(t: Trigger, context: Context) {
  const { plan, routines, signal, now, identities } = context,
    config = t.config;
  if (config.kind !== "folder") return;
  if (!t.baselineComplete) throw new Error("wake_folder_baseline_missing");
  context.dataRoot ??= await realpath(routines.deps.dataDir);
  signal.throwIfAborted();
  if (containsPath(context.dataRoot, config.path, routines.deps.local.deps.platform))
    throw new Error("wake_folder_protected");
  // Deadlines cover all folders, including overflow; omitted watches must never omit due work.
  plan.pollAt = earlier(plan.pollAt, new Date(now + 900000).toISOString());
  if (t.state.pendingCount) {
    const at = t.state.lastTriggeredAt
      ? Date.parse(t.state.lastTriggeredAt) + config.cooldownMin * 60000
      : now;
    plan.checksAt = earlier(plan.checksAt, new Date(at).toISOString());
  }
  if (plan.folders.length === 64) {
    plan.polling = true;
    return;
  }
  let identity = identities.get(config.path);
  if (!identity) {
    identity = await folderIdentity(config.path, signal);
    identities.set(config.path, identity);
  }
  plan.folders.push({
    triggerId: t.id,
    routineId: t.routineId,
    path: config.path,
    events: config.events,
    pattern: config.pattern,
    recursive: config.recursive,
    cooldownMin: config.cooldownMin,
    ...identity,
  });
}
async function addTrigger(t: Trigger, context: Context, paused: boolean) {
  const { config } = t,
    { plan, now } = context;
  if (config.kind === "once" && t.state.consumedAt) return;
  context.active = true;
  if (paused || context.routines.host.suspended) return;
  if (config.kind === "folder") return addFolder(t, context);
  if (config.kind === "github") return;
  if (config.kind === "connection" || config.kind === "calendar") {
    const at = appTriggerDueAt(config, t.createdAt, t.appCheck);
    plan.nextAt = earlier(plan.nextAt, new Date(Math.max(now, at)).toISOString());
    return;
  }
  const at =
    config.kind === "once"
      ? Date.parse(config.at)
      : nextCron(
          config.expr,
          config.timezone,
          Math.max(now, Date.parse(t.state.lastScheduledAt ?? t.lastScheduledAt ?? t.createdAt)),
        );
  plan.nextAt = earlier(plan.nextAt, new Date(Math.max(0, at - 120000)).toISOString());
}
export async function buildWakePlan(options: {
  repo: RoutineWakeRepo;
  routines: RoutineService;
  epoch: string;
  revision: number;
  signal: AbortSignal;
}): Promise<WakePlan> {
  const { repo, routines, signal } = options,
    now = Date.now(),
    paused = routines.settings.pausedUntil();
  const plan: WakePlan = {
    epoch: options.epoch,
    revision: options.revision,
    builtAt: new Date(now).toISOString(),
    nextAt: null,
    checksAt: paused,
    pollAt: routines.pollingAt(),
    folders: [],
    polling: !!routines.pollingAt(),
  };
  const context: Context = { plan, routines, signal, now, active: false, identities: new Map() };
  let before = "",
    count = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = repo.triggers(before);
    for (const t of page) {
      if (++count > 20000) throw new Error("wake_plan_budget");
      signal.throwIfAborted();
      await addTrigger(t, context, !!paused);
    }
    if (page.length < 200) break;
    before = page.at(-1)?.id ?? "";
    await setImmediate(undefined, { signal });
  }
  if (context.active && routines.settings.get().pauseWhenAway) {
    const last = routines.settings.lastUiActiveAt();
    if (last)
      plan.checksAt = earlier(
        plan.checksAt,
        new Date(Date.parse(last) + routines.timing.awayAfterMs).toISOString(),
      );
  }
  signal.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(plan)) > 262144) throw new Error("wake_plan_budget");
  return WakePlanSchema.parse(plan);
}

/** Routines are the brain's only scheduled work: they tell standby when to wake. */
export function routineWakeSource(repo: RoutineWakeRepo, routines: RoutineService): WakeSource {
  return {
    suspended: () => routines.host.suspended,
    automationIdle: () => routines.automationIdle(),
    plan: (input) => buildWakePlan({ ...input, repo, routines }),
  };
}
