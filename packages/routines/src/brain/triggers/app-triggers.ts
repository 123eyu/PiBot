import { ConnectorToolError } from "@pibot/brain/kit";
import {
  CALENDAR_CHECK_INTERVAL_MS,
  CALENDAR_FIRST_CHECK_MS,
  type CalendarTrigger,
  CONNECTION_FIRST_CHECK_MS,
  type ConnectionTrigger,
  type Message,
  type Routine,
  type RoutineRun,
  type RoutineTrigger,
  type RoutineTriggerState,
} from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import type { RoutineService } from "../service.ts";
import {
  AppTriggerError,
  appTriggerErrorCode,
  BROKEN_CONNECTOR_STATUSES,
  catalogTools,
  connectionValue,
  isLocalCalendar,
  readConnection,
  usableConnection,
} from "./app-read.ts";
import {
  CALENDAR_MAX_PAGES,
  type CalendarEvent,
  calendarArgs,
  calendarDecision,
  calendarPage,
  calendarRange,
} from "./calendar-checks.ts";
import { connectionChange, presetCall, resultItems } from "./connection-checks.ts";

type AppConfig = ConnectionTrigger | CalendarTrigger;
type TriggerData = Pick<NonNullable<Message["routineTrigger"]>, "connection" | "calendar">;
interface Outcome {
  state: RoutineTriggerState;
  fire?: { data: TriggerData };
}
/** Concurrent checks across all routines; each is a few bounded connection reads. */
const MAX_JOBS = 3;
const CHECK_TIMEOUT_MS = 120_000;

const isApp = (config: RoutineTrigger["config"]): config is AppConfig =>
  config.kind === "connection" || config.kind === "calendar";

/** When this trigger should look next (also the wake plan's answer). */
export function appTriggerDueAt(
  config: AppConfig,
  createdAt: string,
  last: { checkedAt?: string | null; nextDueAt?: string | null } | undefined,
) {
  if (!last?.checkedAt)
    return (
      Date.parse(createdAt) +
      (config.kind === "connection" ? CONNECTION_FIRST_CHECK_MS : CALENDAR_FIRST_CHECK_MS)
    );
  const regular =
    Date.parse(last.checkedAt) +
    (config.kind === "connection" ? config.intervalMin * 60_000 : CALENDAR_CHECK_INTERVAL_MS);
  return last.nextDueAt ? Math.min(regular, Date.parse(last.nextDueAt)) : regular;
}

/**
 * Connection and calendar triggers. Owns only bounded read jobs; the trigger's new state
 * and the queued run commit together, so a failed or cancelled check changes nothing.
 */
export class RoutineAppTriggers {
  private readonly jobs = new Map<string, Promise<void>>();
  // Its own, so sleep can stop checks in flight instead of waiting out their 120 s deadline.
  private cancelled = new AbortController();
  constructor(private readonly service: RoutineService) {}

  /** Stops checks in flight (nothing is committed for them) and lets later ones start again. */
  async cancel() {
    this.cancelled.abort();
    await this.drain();
    this.cancelled = new AbortController();
  }

  schedule(routine: Routine, now: number) {
    const local = this.service.deps.local;
    for (const trigger of routine.triggers) {
      const config = trigger.config;
      if (!isApp(config) || this.jobs.has(trigger.id) || this.jobs.size >= MAX_JOBS) continue;
      const connector = local.connectors?.get(config.connectorId);
      // `stopping` is a passing state (idle shutdown, reconnect) like `starting`: wait it out.
      // Treating it as broken paused the owner's GitHub routine during a 3-second restart.
      if (
        !connector?.enabled ||
        (BROKEN_CONNECTOR_STATUSES.has(connector.status) && connector.status !== "stopping")
      ) {
        this.fail(routine, trigger, "connection_trigger_unavailable");
        return;
      }
      // A start-up or re-authorization handshake must finish before the read starts.
      if (!["ready", "idle"].includes(connector.status)) continue;
      const checked = trigger.state[config.kind]?.checkedAt;
      if (checked && Date.parse(checked) > now + 60_000) {
        this.fail(routine, trigger, "trigger_clock_skew");
        return;
      }
      if (now < appTriggerDueAt(config, trigger.createdAt, trigger.state[config.kind])) continue;
      const job = this.check(routine, trigger, config, now).finally(() =>
        this.jobs.delete(trigger.id),
      );
      this.jobs.set(trigger.id, job);
    }
  }

  private async check(routine: Routine, trigger: RoutineTrigger, config: AppConfig, now: number) {
    const cancelled = this.cancelled.signal;
    const signal = AbortSignal.any([
      this.service.lifetime.signal,
      cancelled,
      AbortSignal.timeout(CHECK_TIMEOUT_MS),
    ]);
    try {
      const outcome =
        config.kind === "connection"
          ? await this.connection(routine, trigger, config, now, signal)
          : await this.calendar(routine, trigger, config, now, signal);
      signal.throwIfAborted();
      let queued: RoutineRun | undefined;
      const accepted = transaction(this.service.deps.db, () => {
        const current = this.service.scheduleCurrent(routine);
        if (!current) return false;
        if (!this.service.triggers.checkpoint(trigger.id, trigger.state, outcome.state))
          return false;
        if (outcome.fire) {
          queued = this.service.runs.enqueue(
            {
              routineId: routine.id,
              botId: routine.botId,
              triggerId: trigger.id,
              reason: config.kind,
              scheduledFor: new Date(now).toISOString(),
              // One run per committed check: the state CAS above already makes a check commit
              // once, and the same items may legitimately come back in a later check.
              dedupeKey: `${config.kind}:${trigger.id}:${new Date(now).toISOString()}`,
            },
            this.service.timing.queueWaitMs,
          );
          if (queued.status === "scheduled")
            this.service.execution.triggerMessages.ensure(queued, current, {
              paths: [],
              total: 0,
              ...outcome.fire.data,
            });
        }
        return true;
      });
      if (accepted && queued)
        await this.service.publish(queued, this.service.repo.require(routine.id));
    } catch (error) {
      if (this.service.lifetime.signal.aborted || cancelled.aborted) return;
      // A connection that just republished its tools is not broken; the next scan looks again.
      if (error instanceof ConnectorToolError && error.code === "connector_catalog_changed") return;
      this.fail(
        routine,
        trigger,
        appTriggerErrorCode(error),
        error instanceof AppTriggerError ? error.cause : undefined,
      );
    }
  }

  private async connection(
    routine: Routine,
    trigger: RoutineTrigger,
    config: ConnectionTrigger,
    now: number,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const local = this.service.deps.local;
    const call = presetCall(config.check, catalogTools(local, routine.botId, config.connectorId));
    if (!call) throw new AppTriggerError("connection_trigger_check_unavailable");
    const value = await readConnection(
      local,
      { botId: routine.botId, routineId: routine.id },
      { connectorId: config.connectorId, ...call },
      "routine_trigger_check",
      signal,
      () => !!this.service.scheduleCurrent(routine),
    );
    const { fresh, seen } = connectionChange(
      config.check,
      trigger.state.connection?.seen,
      resultItems(config.check, connectionValue(value)),
      now,
    );
    const state = {
      ...trigger.state,
      connection: { checkedAt: new Date(now).toISOString(), seen },
    };
    if (!fresh) return { state };
    return {
      state,
      fire: {
        data: {
          connection: {
            connectorName: (local.connectors?.get(config.connectorId)?.name ?? "").slice(0, 200),
            check: config.check,
            changed: fresh,
          },
        },
      },
    };
  }

  private async calendar(
    routine: Routine,
    trigger: RoutineTrigger,
    config: CalendarTrigger,
    now: number,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const local = this.service.deps.local;
    const connector = usableConnection(local, routine.botId, config.connectorId);
    if (!connector || !isLocalCalendar(local, connector))
      throw new AppTriggerError("calendar_trigger_unavailable");
    const range = calendarRange(config, now);
    const events: CalendarEvent[] = [];
    let cursor: string | undefined,
      complete = false;
    for (let page = 0; page < CALENDAR_MAX_PAGES; page++) {
      const value = await readConnection(
        local,
        { botId: routine.botId, routineId: routine.id },
        {
          connectorId: config.connectorId,
          tool: "list_events",
          args: calendarArgs(config, range, cursor),
        },
        "routine_calendar_check",
        signal,
        () => !!this.service.scheduleCurrent(routine),
      );
      const result = calendarPage(connectionValue(value));
      events.push(...result.events);
      if (!result.nextCursor) {
        complete = true;
        break;
      }
      cursor = result.nextCursor;
    }
    const decision = calendarDecision(
      config,
      trigger.state.calendar,
      events,
      complete,
      now,
      Date.parse(trigger.createdAt),
    );
    const state = { ...trigger.state, calendar: decision.state };
    if (!decision.fire.length) return { state };
    return {
      state,
      fire: {
        data: {
          calendar: {
            event: config.event,
            ...(config.event === "before_start" ? { minutesBefore: config.minutesBefore } : {}),
            events: decision.fire.slice(0, 20).map(({ key: _key, ...event }) => event),
            total: decision.fire.length,
          },
        },
      },
    };
  }

  /** The existing trigger-error path: the task pauses and the inbox shows「触发器异常」. */
  private fail(routine: Routine, trigger: RoutineTrigger, code: string, cause?: string) {
    const current = this.service.scheduleCurrent(routine);
    if (!current) return;
    this.service.pause(current, "trigger_error");
    this.service.changed(current.id);
    this.service.deps.logger.warn(
      JSON.stringify({
        module: "routine-app-trigger",
        event: "check_failed",
        code,
        ...(cause ? { cause } : {}),
        routineId: routine.id,
        triggerId: trigger.id,
      }),
    );
  }
  isIdle() {
    return this.jobs.size === 0;
  }
  async drain() {
    await Promise.all(this.jobs.values());
  }
}
