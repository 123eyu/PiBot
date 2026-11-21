import { createContext, type ReactNode, useContext } from "react";
import { useTasks } from "./use-tasks.ts";

const Context = createContext<ReturnType<typeof useTasks> | null>(null);
/**
 * One task center for the Tasks tab and the chat tab's summary (in progress / waiting /
 * done today). Shared so the summary never makes reads of its own.
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useTasks()}>{children}</Context.Provider>;
}
export function useTaskCenter() {
  const value = useContext(Context);
  if (!value) throw new Error("tasks_unavailable");
  return value;
}
