import { TaskCenterSchema } from "../features/tasks/pages.ts";
import type { MobileRuntime } from "../runtime/runtime.ts";
import type { PushEvent } from "../transport/push-route.ts";
import type { NoticeRoute } from "./decide.ts";

/** The screen a route opens, as an expo-router href. */
export async function routeHref(runtime: MobileRuntime, computerId: string, route: NoticeRoute) {
  switch (route.screen) {
    case "approval":
      return `/approval/${route.id}`;
    case "browser":
      return `/browser/${route.botId}${route.topic ? `?topic=${encodeURIComponent(route.topic)}` : ""}`;
    case "chat":
      return `/conversation/${route.kind}/${route.id}`;
    case "task": {
      // Task detail opens from the phone's task-center copy; a run it has not seen yet (or a
      // child task's run, which the center does not list) opens the task center instead.
      const center = TaskCenterSchema.safeParse(
        await runtime.storage.data.get(`cache:${computerId}:tasks`),
      );
      const known =
        center.success &&
        (route.kind === "run"
          ? center.data.runs.some((run) => run.id === route.id)
          : center.data.routines.some((run) => run.id === route.id));
      return known ? `/task/${route.kind}/${route.id}` : "/(tabs)/tasks";
    }
  }
}
/** A push names only an approval or a run; the screens it can open are the same. */
export function pushRoute(event: PushEvent): NoticeRoute | undefined {
  if (event.approvalId) return { screen: "approval", id: event.approvalId };
  if (event.runId) return { screen: "task", kind: "run", id: event.runId };
  return undefined;
}
/** What the person is looking at, from the router path (for "nothing for the open chat"). */
export function screenOf(
  pathname: string,
  params: Record<string, unknown>,
): NoticeRoute | undefined {
  const [, first, second, third] = pathname.split("/");
  if (first === "conversation" && (second === "bot" || second === "group") && third)
    return { screen: "chat", kind: second, id: third };
  if (first === "approval" && second) return { screen: "approval", id: second };
  if (first === "browser" && second)
    return {
      screen: "browser",
      botId: second,
      ...(typeof params.topic === "string" ? { topic: params.topic } : {}),
    };
  if (first === "task" && (second === "run" || second === "routine") && third)
    return { screen: "task", kind: second, id: third };
  return undefined;
}
